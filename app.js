/* ==============================================================
   NRCC Work Permit System — Application Logic
   Stack: Firebase (Auth + Firestore offline persistence), vanilla JS PWA.
   This file is organised top-to-bottom as:
     1. Firebase init        2. State & helpers     3. Auth/bootstrap
     4. App shell & router   5. Views (dashboard, permits, equipment, admin)
     6. Permit + isolation + trial-run logic   7. PDF/print
   See the Setup & User Manual for how everything fits together.
   ============================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  writeBatch, arrayUnion, arrayRemove, onSnapshot, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, appBranding } from "./firebase-config.js";

/* -------------------- 1. Firebase init -------------------- */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* -------------------- 2. State & helpers -------------------- */
const State = { user: null, profile: null, config: null, view: "dashboard", params: {} };

// Master job-title list (exact order). Stored in config/app so Admins can
// add/remove entries; this is the seed/default when config has none.
const DEFAULT_JOB_TITLES = [
  "Technician", "Foreman", "Supervisor", "CCR Operator", "Shift Engineer",
  "Patrolman", "Engineer", "Chief Engineer", "Manager", "Shift Supervisor",
  "PPM Inspector", "Quality Supervisor", "Lab Technician", "Safety Officer", "Officer"
];

// Auto-rejection policy (see "Auto-rejection" in section 2 for the whole story).
//   submittedHours          waiting for an Issuer's decision
//   awaitingIsolationHours  approved, waiting for an Isolator to apply the locks
//   reinstateHours          how long an Issuer may put an auto-rejected permit back
// The two waits differ because they cost different things: an approved permit is
// already holding a certificate, so it gets the shorter rope. Both are generous
// enough to survive a weekend — a threshold that fires on ordinary permits
// teaches everyone to ignore it, and then it protects nothing.
const AUTO_REJECT_DEFAULT = { enabled: true, submittedHours: 72, awaitingIsolationHours: 48, reinstateHours: 24 };

const DEFAULT_CONFIG = {
  permitTypes: [
    { code: "general", name: "General / Cold Work", abbr: "GEN", requiresIsolation: false, requiresGasTest: false,
      checklist: ["Work area inspected and safe", "Correct tools in good condition", "Housekeeping arranged", "Access / egress clear"] },
    { code: "hot", name: "Hot Work", abbr: "HOT", requiresIsolation: false, requiresGasTest: true,
      checklist: ["Fire watch assigned", "Suitable fire extinguisher on site", "Combustibles removed or covered", "Area gas-tested where required", "Hot work stopped 30 min before shift end"] },
    { code: "loto", name: "Electrical Isolation (LOTO)", abbr: "LOTO", requiresIsolation: true, requiresGasTest: false,
      checklist: ["Equipment de-energised", "Locks and tags applied", "Zero-energy state verified", "Stored / residual energy released", "Try-start test done"] },
    { code: "confined", name: "Confined Space Entry", abbr: "CSE", requiresIsolation: true, requiresGasTest: true,
      checklist: ["Gas test completed and acceptable", "Standby person assigned", "Ventilation provided", "Entry / exit log maintained", "Rescue arrangement in place"] }
  ],
  lines: ["Line 1", "Line 2", "Common"],
  areas: ["Crusher", "Stacker", "Raw Mill + Pre-heater", "Kiln", "Cooler", "Cement Mill", "Transport", "Grinding", "Silo", "Packing Plant"],
  departments: [
    { name: "Maintenance", subUnits: ["Mechanical", "PPM", "Electrical", "Instrument / PLC"] },
    { name: "Production", subUnits: [] },
    { name: "Quality Control", subUnits: [] }
  ],
  ppeList: ["Helmet", "Safety shoes", "Gloves", "Eye protection", "Ear protection", "Face shield", "Respirator", "Full body harness", "FR coverall", "Insulating gloves"],
  jobTitles: [...DEFAULT_JOB_TITLES],
  // How long a permit may wait for a decision before it auto-rejects. Stored in
  // config/app like everything else here so the safety officer can tune it from
  // the Admin screen — see AUTO_REJECT_DEFAULT for what each number means.
  autoReject: { ...AUTO_REJECT_DEFAULT }
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nowISO = () => new Date().toISOString();
const uid = () => "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso); if (isNaN(d)) return "—";
  return d.toLocaleString([], { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso) { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" }); }
function initials(name) { return (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }
// Coalesce bursts of calls into one. Used on free-text search boxes: each
// keystroke otherwise refilters the whole list and rebuilds the entire table,
// so typing an 8-character tag redrew it eight times. Dropdowns are NOT
// debounced — a single discrete choice should apply immediately.
function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
// Planned end of a permit (an explicit extension wins; open-ended never expires).
function permitEnd(p) { return p?.validity?.openEnded ? null : (p?.validity?.extendedTo || p?.validity?.plannedEnd || null); }
// A still-live permit whose planned end has passed is "overdue". We never change
// the stored status automatically (that would need a server write); instead the
// UI flags it so an Issuer extends or closes it.
function isOverdue(p) {
  if (!p || !["active", "extended", "awaitingIsolation"].includes(p.status)) return false;
  const end = permitEnd(p); if (!end) return false;
  const d = new Date(end); return !isNaN(d) && d.getTime() < Date.now();
}
function overdueChip() { return `<span class="badge-st st-overdue" title="Planned end has passed">Overdue</span>`; }

/* -------------------- Auto-rejection --------------------
   A permit waiting for a decision is not harmless to leave alone, and the cost is
   worst for the ones that were already approved. An `awaitingIsolation` permit
   holds a certificate, and that certificate holds `equipment.activeIsolationId` —
   which txEquipmentPointer() requires to be EMPTY before any other permit on that
   tag can be approved. So one approval that no Isolator ever confirmed locks the
   equipment out of the permit system indefinitely, and nothing here notices,
   because isOverdue() only speaks for permits that already carry a planned end.
   (A forgotten `submitted` permit is milder — it does not hard-block, it sits in
   the Issuer's queue and shows up in every concurrent-work warning on that tag
   until the warnings stop being read.) Auto-rejection closes both.

   IT IS DELIBERATELY NOT A REJECTION. `rejection` carries a person, their name and
   a reason; a timeout has none of the three, and writing "Rejected" into a permit's
   history would record a safety decision that nobody made — precisely the thing an
   audit is meant to catch. An auto-rejected permit takes the `expired` status,
   which every terminal-status gate in the app already handles, and is labelled
   "Auto-rejected" everywhere a human sees it.

   TWO RULES, whichever falls first:
     1. plannedEnd — the permit's own planned end passes while it is still waiting.
        A submitted permit must carry a planned end or be explicitly open-ended, so
        this covers most permits using the requester's own dates rather than any
        number we invented. Approving a permit whose window has already closed is
        the thing actually worth preventing.
     2. idle — a fixed timeout, which exists only for the open-ended permits that
        rule 1 cannot reach.

   DERIVED, NEVER STORED, exactly like isOverdue: this is a static site with no
   server, so there is no scheduled job to run the clock, and a stored status would
   be wrong for however long nobody opened the app. Every gate below reads the
   derived state, so the feature is correct whether or not anything was written.
   stampAutoReject() additionally writes the status when an Issuer or Admin looks
   at such a permit — that is what puts it in the permanent record — but nothing
   depends on that write having happened. */
function autoRejectPolicy() { return { ...AUTO_REJECT_DEFAULT, ...(State.config?.autoReject || {}) }; }
// When the wait began, per state: a submitted permit runs from submission, an
// approved one from approval. `submittedAt` is stamped on the submit paths so
// that editing a submitted permit cannot quietly restart its clock; the
// fallbacks cover permits written before that field existed.
function autoRejectFrom(p) {
  return (p?.status === "submitted"
    ? (p.submittedAt || p.updatedAt || p.createdAt)
    : (p?.approval?.timestamp || p?.updatedAt || p?.createdAt)) || null;
}
// The deadline and which rule set it, or null if this permit is not waiting on
// anybody (or the policy is switched off). Earliest rule wins.
function autoRejectDue(p, pol) {
  if (!p || !pol || pol.enabled === false) return null;
  if (!["submitted", "awaitingIsolation"].includes(p.status)) return null;
  const due = [];
  const end = Date.parse(permitEnd(p) || "");   // open-ended → null → NaN → skipped
  if (!isNaN(end)) due.push({ at: end, rule: "plannedEnd" });
  const hours = p.status === "submitted" ? pol.submittedHours : pol.awaitingIsolationHours;
  const from = Date.parse(autoRejectFrom(p) || "");
  if (!isNaN(from) && hours > 0) due.push({ at: from + hours * 3600000, rule: "idle" });
  if (!due.length) return null;                // undatable and open-ended: never accuse it
  return due.sort((a, b) => a.at - b.at)[0];
}
// Automation must never conclude that physical locks should come off. Rejecting an
// awaitingIsolation permit by hand decides exactly that (see the reject handler):
// while the certificate is still `assigned` the locks were demonstrably never
// applied, so it is cancelled and the equipment freed — but at any later status an
// Isolator has signed that the locks ARE on, and rejection sends the certificate to
// removalPending, i.e. dispatches somebody to remove them. A timeout may only ever
// take the first branch, and only when no other crew shares the lockout. Everything
// else stays exactly where it is and is merely flagged to the Issuer.
function autoRejectSafe(p, isolations) {
  if (!p?.isolationRef) return true;
  const iso = isoIndex(isolations).get(p.isolationRef);
  if (!iso) return false;                      // unknown lock state: never guess
  if (iso.status === "removed") return true;
  if (iso.status !== "assigned") return false;
  return !(iso.attachedPermitIds || []).some((x) => x !== p.id);
}
// The whole derived state of one permit, or null if it is not waiting on a decision:
//   pending  waiting, deadline still ahead
//   warn     past the halfway mark — shown so the deadline is never a surprise
//   lapsed   past it: auto-rejected, and treated as terminal everywhere below
//   held     past it, but holding a lockout, so it is flagged and NOT acted on
// `now` is a parameter so the whole thing can be tested without waiting three days.
function autoRejectState(p, isolations, pol, now = Date.now()) {
  const due = autoRejectDue(p, pol);
  if (!due) return null;
  if (now >= due.at) return { ...due, phase: autoRejectSafe(p, isolations) ? "lapsed" : "held" };
  const from = Date.parse(autoRejectFrom(p) || "");
  return { ...due, phase: !isNaN(from) && now >= from + (due.at - from) / 2 ? "warn" : "pending" };
}
function isAutoRejected(p, isolations, pol) { return autoRejectState(p, isolations, pol)?.phase === "lapsed"; }
// Both the stored status and the derived one. Used by the gates that must treat an
// auto-rejected permit as finished whether or not the write has happened yet.
function permitDead(p, isolations, pol) {
  return ["closed", "rejected", "expired"].includes(p?.status) || isAutoRejected(p, isolations, pol);
}
const AUTO_REJECT_RULE = {
  plannedEnd: "its planned end passed while it was still waiting for a decision",
  idle: "no decision was recorded within the allowed time"
};
function hoursText(ms) {
  const h = Math.round(ms / 3600000);
  if (h <= 0) return "now";
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(h / 24)} days`;
}
// Shown beside the status badge. The warn chip is the point of the whole feature
// being visible rather than silent: nobody should discover a deadline by losing to it.
function autoRejectChip(st) {
  if (!st) return "";
  if (st.phase === "lapsed") return ` <span class="badge-st st-expired" title="${esc(AUTO_REJECT_RULE[st.rule])}">Auto-rejected</span>`;
  if (st.phase === "held") return ` <span class="badge-st st-overdue" title="Past its auto-reject deadline, but its lockout must be handled by a person">Auto-reject held</span>`;
  if (st.phase === "warn") return ` <span class="badge-st st-lapsing" title="Auto-rejects ${esc(fmt(new Date(st.at).toISOString()))}">Auto-rejects in ${esc(hoursText(st.at - Date.now()))}</span>`;
  return "";
}
// How long a permit has been live on site: from approval, not from when the
// draft was raised. A permit that sat unsubmitted in a Requester's drafts for
// a week has not been live for a week. The fallbacks cover records written
// before the approval stamp existed.
function permitLiveSince(p) { return p?.approval?.timestamp || p?.validity?.start || p?.createdAt || null; }
// Most permits here are open-ended, so no planned end ever passes and the
// Overdue flag can never apply to them — elapsed time is the only thing left
// that says a job may have been forgotten. Work still in progress past these
// many days colours its whole row on the dashboard. Both are deliberately
// generous: a marking that lands on nearly every row says nothing at all.
const PERMIT_STALE_DAYS = 7;         // amber
const PERMIT_LONG_STALE_DAYS = 21;   // red
// 0 = fine, 1 = stale, 2 = long stale. Two levels rather than one so a card
// shows the shape of the backlog at a glance, not merely that one exists.
// Takes the moment the wait began rather than the permit, because "waiting
// since" differs by who is looking: the Issuer's card counts from approval,
// the Requester's from whenever the permit last landed back on their desk.
function staleLevel(since) {
  const t = Date.parse(since);
  if (isNaN(t)) return 0;            // undatable: never accuse it
  const days = (Date.now() - t) / 86400000;
  return days >= PERMIT_LONG_STALE_DAYS ? 2 : days >= PERMIT_STALE_DAYS ? 1 : 0;
}
// The two things — the only two — that a Requester can act on: a draft they
// have never submitted, and a live permit whose job they have not yet
// confirmed finished. The second is the one that quietly costs: until that
// sign-off the Isolator cannot de-isolate and the Issuer cannot close, so the
// permit holds its equipment out of service while nobody is waiting on it.
function awaitsRequester(p) {
  return p?.status === "draft" ||
    (["active", "extended"].includes(p?.status) && !p.workCompletion);
}
// When it started waiting on them. A draft's clock restarts whenever they open
// and save it — a draft edited yesterday is not a forgotten one — while a live
// permit runs from approval, the same clock the Issuer's card uses.
function requesterWaitSince(p) {
  return p?.status === "draft" ? (p?.updatedAt || p?.createdAt || null) : permitLiveSince(p);
}
// Order for the Requester's own card. Anything waiting on them comes first,
// longest-waiting at the top — the point of the card is the permit they have
// forgotten, and with a 12-row cap a three-month-old draft was not merely
// buried, it was off the card entirely. Everything else keeps the fetch order
// (newest first): those permits are with the Issuer or the Isolator, or they
// are finished, and recency is the right way to read history.
function byOwnAttention(a, b) {
  const ra = awaitsRequester(a) ? 0 : 1, rb = awaitsRequester(b) ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (ra === 1) return 0;            // stable sort keeps fetch order below
  return (Date.parse(requesterWaitSince(a)) || Infinity) - (Date.parse(requesterWaitSince(b)) || Infinity);
}
// A live permit's stored status stays "active"/"extended" from approval until
// the Issuer closes it, which hides how far the hand-back has progressed.
// Like isOverdue, the stage is derived in the UI (never stored) from the
// workCompletion sign-off plus the isolation certificate's status.
const STAGE_LABEL = { inProgress: "Work in progress", awaitingDeisolation: "Awaiting de-isolation", awaitingClosure: "Awaiting closure" };
// Certificates indexed by id. Building this once per render turns the per-row
// certificate lookup in permitStage from a scan of the whole certificate list
// into a single map hit — the difference between permits x certificates work
// and permits work when a register of any size is drawn.
function isoIndex(isolations) {
  return isolations instanceof Map ? isolations : new Map((isolations || []).map((i) => [i.id, i]));
}
// `isolations` may be the raw array or an isoIndex() map — callers rendering
// many rows should pass the map, one-off callers can keep passing the array.
function permitStage(p, isolations) {
  if (!p || !["active", "extended"].includes(p.status)) return null;
  if (!p.workCompletion) return "inProgress";
  const iso = !p.isolationRef ? null
    : isolations instanceof Map ? isolations.get(p.isolationRef)
    : (isolations || []).find((i) => i.id === p.isolationRef);
  const deisolated = !p.isolationRef || (iso && iso.status === "removed");
  return deisolated ? "awaitingClosure" : "awaitingDeisolation";
}
function stageChip(stage) {
  return stage ? ` <span class="badge-st stage-${stage}">${STAGE_LABEL[stage]}</span>` : "";
}
// A trial run is shown as a chip ALONGSIDE the permit's status and stage, never
// as a status or a permitStage() value: `["active","extended"]` and the three
// stage names are load-bearing in the cycle, hand-back and dashboard logic (and
// in their tests), and a permit in a trial run is still an active permit.
function trialChip(iso) {
  if (isTrialEnergised(iso)) return ` <span class="badge-st stage-trialRun">TRIAL RUN — ENERGISED</span>`;
  const st = trialStage(iso);
  if (st === "requested") return ` <span class="badge-st stage-trialPending">Trial run requested</span>`;
  if (st === "approved") return ` <span class="badge-st stage-trialPending">Trial run authorised</span>`;
  return "";
}
// Cycle-based equipment availability. Joining a still-working shared isolation
// is allowed (several crews under one lockout), but once the hand-back has
// begun the equipment is blocked for NEW permits until the Issuer closes every
// permit — i.e. when any live permit is awaiting closure, or the lockout's
// de-isolation is pending / all its crews have signed off. Overdue alone does
// not block (the Issuer extends or closes at their discretion — warned only).
//
// `pol` is the auto-rejection policy: a permit past its deadline is not part of
// the live set, so it can neither contribute a block nor be listed as concurrent
// work. Omitting it (the default) disables auto-rejection for this call, which is
// how the pure-logic tests pin the pre-existing behaviour.
function equipmentBlock(eqId, permits, isolations, excludeId, pol = null) {
  const isoMap = isoIndex(isolations);
  const live = permits.filter((p) => p.equipmentRef === eqId && p.id !== excludeId &&
    ["submitted", "awaitingIsolation", "active", "extended"].includes(p.status) &&
    !isAutoRejected(p, isoMap, pol));
  const closing = live.filter((p) => permitStage(p, isoMap) === "awaitingClosure");
  if (closing.length) return { kind: "awaitingClosure", permits: closing };
  const liveIsoIds = new Set(live.map((p) => p.isolationRef).filter(Boolean));
  if (!liveIsoIds.size) return null;
  const byIso = permitsByIso(permits);
  for (const iid of liveIsoIds) {
    const iso = isoMap.get(iid);
    if (iso && (iso.status === "removalPending" || (iso.status === "active" && isoReadyForDeiso(iso, permits, byIso))))
      return { kind: "awaitingDeisolation", permits: live.filter((p) => p.isolationRef === iid) };
  }
  return null;
}
const BLOCK_TEXT = {
  awaitingClosure: "an earlier permit is awaiting closure by the Issuer",
  awaitingDeisolation: "its lockout is in hand-back (de-isolation pending)",
};

/* -------------------- Equipment work cycle (NOT YET IN USE) --------------------
   Groundwork only. Nothing below is called from any production path yet; it is
   here so its agreement with the live gate can be measured before anything is
   allowed to depend on it (tests/cycle-equivalence.mjs).

   WHY THIS EXISTS. equipmentBlock() above answers "can new work start on this
   equipment?" by scanning every permit and every certificate. Because that is a
   QUERY, it can be neither wrapped in a Firestore transaction (transactions may
   only get() named documents) nor expressed in security rules (which cannot
   query either). So the rule lives solely in client JavaScript, is checked
   before a dialog opens rather than atomically with the write, and cannot be
   enforced against a stale or misbehaving client at all.

   The fix is to make the same answer a property of ONE document — the equipment
   record — maintained by each lifecycle transition. A single-document read can
   sit inside the transaction that it guards, and can be enforced in rules.

   `cycle` shape:
     { v, state, open: { [permitId]: { s, c } }, certId, certState, seq }
       state     "idle" | "working" | "handback"   — always derived, never set
       open      one entry per LIVE permit on this equipment
       s         "w" working | "d" crew has signed off work-complete
       c         id of the lockout holding this permit, or null if none/removed
       certId    the equipment's current certificate (mirrors activeIsolationId)
       certState that certificate's status
       seq       ++ per transition; drift detection once dual-writing begins  */

// Derived availability. Order matters: the removalPending check must come first
// because locks can be physically on with no permits left at all (rejecting the
// last permit on a confirmed certificate leaves exactly that state).
function computeCycleState(cycle) {
  if (cycle.certState === "removalPending") return "handback";
  const entries = Object.values(cycle.open || {});
  if (!entries.length) return "idle";
  // A crew signed off and is held by no lockout → the Issuer must close it.
  if (entries.some((e) => e.s === "d" && !e.c)) return "handback";
  // Every crew on the equipment's own lockout has signed off → de-isolation is
  // due. Restricted to certId/`active` to mirror isoReadyForDeiso, which only
  // treats a CONFIRMED certificate as ready (an assigned or trial-run one is
  // not in hand-back).
  if (cycle.certId && cycle.certState === "active") {
    const onCert = entries.filter((e) => e.c === cycle.certId);
    if (onCert.length && onCert.every((e) => e.s === "d")) return "handback";
  }
  return "working";
}

/* -------------------- Data audit --------------------
   Read-only integrity check over the three collections. It exists because a
   lockout that the equipment record does not point at is invisible to the
   equipment: nothing derived from that one document can see it, so it cannot be
   reported, cleaned up, or reasoned about by any single-document rule. The
   approval transactions now stop new ones being created; this finds any that
   were created before that, plus the neighbouring kinds of broken reference
   that make a permit or a certificate impossible to resolve.

   Pure so it can be tested (tests/data-audit.mjs). Reads nothing, writes
   nothing — the caller supplies the collections. `equipment` MUST be the
   unfiltered collection, archived items included: an archived record still
   carries the pointer that a live certificate is checked against. */
const AUDIT_LIVE_PERMIT = ["submitted", "awaitingIsolation", "active", "extended"];
const AUDIT_LIVE_CERT = ["assigned", "active", "trialRun", "removalPending"];

function auditData(permits, isolations, equipment) {
  permits = permits || []; isolations = isolations || []; equipment = equipment || [];
  const isoById = new Map(isolations.map((i) => [i.id, i]));
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const findings = [];
  const add = (id, severity, title, why, items) => { if (items.length) findings.push({ id, severity, title, why, items }); };

  // The Tier 3 precondition. A live permit held by a certificate that its
  // equipment does not point at: the equipment cannot see that lockout, so a
  // rule derived from the equipment alone would treat it as free.
  add("orphanHeld", "critical",
    "Live permit held by a certificate its equipment does not point at",
    "The equipment record cannot see this lockout, so availability derived from the equipment would wrongly treat it as free. Close or de-isolate these, or correct the equipment's current certificate.",
    permits.filter((p) => {
      if (!AUDIT_LIVE_PERMIT.includes(p.status) || !p.isolationRef) return false;
      const iso = isoById.get(p.isolationRef);
      if (!iso || iso.status === "removed") return false;
      const eq = eqById.get(p.equipmentRef);
      return !!eq && (eq.activeIsolationId || null) !== p.isolationRef;
    }).map((p) => ({ label: `${p.permitNo || p.id} — ${p.equipmentTag || p.equipmentRef}`,
      note: `held by ${isoById.get(p.isolationRef)?.isoNo || p.isolationRef}, equipment points at ${eqById.get(p.equipmentRef)?.activeIsolationId ? (isoById.get(eqById.get(p.equipmentRef).activeIsolationId)?.isoNo || "another certificate") : "no certificate"}`,
      view: "detail", id: p.id })));

  // A certificate that believes it is live while its equipment has moved on.
  // Locks may still be physically applied with nothing pointing at them.
  add("orphanCert", "critical",
    "Live certificate the equipment does not point at",
    "Locks may still be applied with no equipment record referring to them. Confirm on site, then de-isolate or release the certificate.",
    isolations.filter((i) => {
      if (!AUDIT_LIVE_CERT.includes(i.status)) return false;
      const eq = eqById.get(i.equipmentRef);
      return !!eq && (eq.activeIsolationId || null) !== i.id;
    }).map((i) => ({ label: `${i.isoNo || i.id} — ${i.equipmentTag || i.equipmentRef}`,
      note: `certificate is ${STATUS_LABEL[i.status] || i.status}`, view: "isodetail", id: i.id })));

  // Equipment pointing at a certificate that is gone or finished — it will read
  // as isolated/pending forever and block new work with nothing to release.
  add("stalePointer", "warning",
    "Equipment pointing at a removed or missing certificate",
    "The equipment will keep reading as isolated with no certificate to act on. Clearing the pointer returns it to service.",
    equipment.filter((e) => {
      if (!e.activeIsolationId) return false;
      const iso = isoById.get(e.activeIsolationId);
      return !iso || iso.status === "removed";
    }).map((e) => ({ label: e.tag || e.id,
      note: isoById.get(e.activeIsolationId) ? "certificate is removed" : "certificate does not exist",
      view: "equipment" })));

  // Isolation status and pointer telling different stories.
  add("statusMismatch", "warning",
    "Equipment isolation status disagrees with its certificate",
    "Cosmetic in most views, but the status is what the equipment register and pickers show.",
    equipment.filter((e) => {
      const st = e.isolationStatus || "available";
      const iso = e.activeIsolationId ? isoById.get(e.activeIsolationId) : null;
      const live = iso && iso.status !== "removed";
      return (st === "available") === !!live;
    }).map((e) => ({ label: e.tag || e.id,
      note: `status ${STATUS_LABEL[e.isolationStatus || "available"] || e.isolationStatus} but ${e.activeIsolationId ? "certificate " + (isoById.get(e.activeIsolationId) ? STATUS_LABEL[isoById.get(e.activeIsolationId).status] : "missing") : "no certificate"}`,
      view: "equipment" })));

  // Broken references — these make a record impossible to resolve at all.
  add("danglingIso", "warning",
    "Permit referencing a certificate that does not exist",
    "The permit's hand-back stage cannot be derived, so it may never become closable.",
    permits.filter((p) => p.isolationRef && !isoById.has(p.isolationRef))
      .map((p) => ({ label: p.permitNo || p.id, note: `missing certificate ${p.isolationRef}`, view: "detail", id: p.id })));

  add("danglingEquip", "warning",
    "Permit referencing equipment that does not exist",
    "Approval cannot create a certificate for this permit — the equipment record it needs is gone.",
    permits.filter((p) => p.equipmentRef && !eqById.has(p.equipmentRef))
      .map((p) => ({ label: p.permitNo || p.id, note: `missing equipment ${p.equipmentTag || p.equipmentRef}`, view: "detail", id: p.id })));

  add("certNoEquip", "warning",
    "Certificate referencing equipment that does not exist",
    "The certificate cannot be de-isolated normally, because de-isolation resets the equipment record.",
    isolations.filter((i) => AUDIT_LIVE_CERT.includes(i.status) && i.equipmentRef && !eqById.has(i.equipmentRef))
      .map((i) => ({ label: i.isoNo || i.id, note: `missing equipment ${i.equipmentTag || i.equipmentRef}`, view: "isodetail", id: i.id })));

  // Trial-run drift. Energising moves THREE records at once — the certificate's
  // status, its trial sub-document, and the equipment's status — so a
  // half-applied state means the app is telling two different stories about
  // whether a machine is live. Written without the trial helpers on purpose:
  // this function is lifted whole into tests/data-audit.mjs.
  add("trialEqNotCert", "critical",
    "Equipment marked energised for a trial its certificate does not have",
    "The equipment register reads ENERGISED but no certificate says a trial run is in progress, so nothing in the app will ever re-isolate it and the machine stays out of service. An Isolator should confirm the real state on site and correct it.",
    equipment.filter((e) => {
      if (e.isolationStatus !== "trialRun") return false;
      const cert = e.activeIsolationId ? isoById.get(e.activeIsolationId) : null;
      return !cert || (cert.status !== "trialRun" && !cert.trialRun);
    }).map((e) => ({ label: e.tag || e.id,
      note: e.activeIsolationId ? `certificate ${isoById.get(e.activeIsolationId)?.isoNo || e.activeIsolationId} is not in a trial run` : "no current certificate",
      view: "equipment" })));

  // The dangerous direction of the same drift: the certificate says the locks
  // are out, the register says isolated.
  add("trialCertNotEq", "critical",
    "Certificate in a trial run whose equipment does not say so",
    "The certificate records that the locks are out, but the equipment register reads isolated. Anyone judging the machine from the register alone — including this app's own availability checks — would treat a live machine as safe.",
    isolations.filter((i) => i.status === "trialRun" &&
      !(i.equipmentRef && eqById.get(i.equipmentRef)?.isolationStatus === "trialRun"))
      .map((i) => ({ label: i.isoNo || i.id,
        note: `${i.equipmentTag || i.equipmentRef || "equipment"} reads ${eqById.get(i.equipmentRef)?.isolationStatus || "unknown"}`,
        view: "isodetail", id: i.id })));

  add("trialOnDeadCert", "warning",
    "Trial run recorded on a certificate that is no longer live",
    "Energising requires an active certificate, so this request can never be actioned — it sits waiting on people who have nothing to act on. Cancel it from the certificate.",
    isolations.filter((i) => i.trialRun && !["active", "trialRun"].includes(i.status))
      .map((i) => ({ label: i.isoNo || i.id, note: `certificate is ${i.status}`, view: "isodetail", id: i.id })));

  add("trialStranded", "warning",
    "Permit whose trial-run log was left open by the earlier flow",
    "The permit's own log still reads ENERGISED while its certificate is not in a trial run — the record disagrees with reality. Re-isolating from the certificate closes these out.",
    permits.filter((p) => (p.trialRuns || []).some((t) => t && t.status === "open") &&
      isoById.get(p.isolationRef)?.status !== "trialRun")
      .map((p) => ({ label: p.permitNo || p.id, note: "log still reads ENERGISED", view: "detail", id: p.id })));

  return findings;
}

// Derive a complete cycle block for one equipment item from the raw
// collections. This is the reference implementation: the backfill/repair tool
// will use it, and the equivalence harness uses it as the oracle.
//
// PRECONDITION, measured not assumed (tests/cycle-equivalence.mjs, section 2):
// no live permit may reference a certificate other than its equipment's current
// one. A single-document model cannot see the status of a certificate the
// equipment does not point at, so where such orphans exist this model is MORE
// PERMISSIVE than the query gate — it allows work the current code blocks,
// which is the wrong direction to be wrong in. Approval transactions (#36) stop
// new orphans being created; any pre-existing ones must be found and resolved
// before availability is allowed to be decided from `cycle`.
function buildCycle(equip, permits, isolations) {
  const isoById = isoIndex(isolations);
  const open = {};
  for (const p of permits) {
    if (p.equipmentRef !== equip.id) continue;
    if (!["submitted", "awaitingIsolation", "active", "extended"].includes(p.status)) continue;
    const iso = p.isolationRef ? isoById.get(p.isolationRef) : null;
    // Decoupled means the same thing as permitStage's `deisolated`: no lockout,
    // or a lockout that has been removed. A reference to a certificate that no
    // longer exists counts as STILL coupled — the locks are unaccounted for,
    // which is not a reason to call the equipment free.
    const c = !p.isolationRef ? null : (iso && iso.status === "removed") ? null : p.isolationRef;
    const done = ["active", "extended"].includes(p.status) && !!p.workCompletion;
    open[p.id] = { s: done ? "d" : "w", c };
  }
  const certId = equip.activeIsolationId || null;
  const cert = certId ? isoById.get(certId) : null;
  const cycle = { v: 1, open, certId, certState: cert ? cert.status : null, seq: 0 };
  cycle.state = computeCycleState(cycle);
  return cycle;
}
function blockBox(equipTag, block, isolations) {
  return `<div class="danger-box"><b>${esc(equipTag)} is not available for a new permit</b> — ${BLOCK_TEXT[block.kind]}. Every permit must be closed before new work can start on this equipment.
    <div class="attached-list" style="margin-top:.5rem">${block.permits.map((p) => `<div class="a"><span class="mono">${esc(p.permitNo)}</span> ${esc(p.typeName)} · ${esc(p.requester?.name || "")} ${badge(p.status)}${stageChip(permitStage(p, isolations))}</div>`).join("")}</div></div>`;
}
// Minimal RFC-4180-ish CSV line parser: handles quoted fields and embedded
// commas / doubled quotes (naive split() corrupted any description with a comma).
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
// Firestore write promises resolve only on SERVER acknowledgement. When the
// device is offline the write is queued locally (and syncs later) but the
// promise never settles — so every `await updateDoc(...); toast(...)` flow
// would silently freeze, despite the app being "offline-first". When offline,
// give the local cache a moment to apply, then continue optimistically.
function fsWrite(p) {
  if (navigator.onLine) return p;
  return Promise.race([p, new Promise((res) => setTimeout(res, 600))]);
}

/* -------------------- Safety-lifecycle writes --------------------
   Approving, rejecting, isolating, de-isolating, trial-running and closing are
   SAFETY decisions. They must never be reported as done unless the server has
   actually accepted them.

   fsWrite above is deliberately optimistic — offline it resolves after 600ms so
   a benign edit (a draft, an equipment description) queues and syncs later. For
   a lifecycle change that is exactly wrong: the Issuer would be told "approved"
   for a write still sitting in the local queue, which may yet be rejected by the
   security rules, and nobody would ever learn.

   A timeout that merely REJECTS would not fix it either: the queued mutation
   still applies whenever the connection returns, so "not recorded" would become
   its own lie. Firestore TRANSACTIONS are the honest primitive — they are never
   queued, they require a server round trip, and they fail outright when one
   cannot be made. That gives a true yes/no, and lets the same call re-read and
   re-check its preconditions atomically with the write it is protecting.

   navigator.onLine is deliberately NOT consulted: it only reports whether a
   network interface exists, and returns true on a captive portal or a plant LAN
   with no route to Firestore. The server's acknowledgement is the only truth. */

// A precondition failed inside a transaction (the data changed under us). Its
// message is written for the user and is shown as-is.
class GateError extends Error {}
function gate(msg) { throw new GateError(msg); }

// True for the transport-level failures that mean "we never reached the server".
function isUnreachable(e) {
  const s = `${e?.code || ""} ${e?.message || ""}`.toLowerCase();
  return /unavailable|deadline|network|offline|failed to get document because the client is offline/.test(s);
}

// Run a lifecycle change as a transaction. `action` names the change for the
// failure message ("approval", "closure", …). Resolves only on a real commit;
// otherwise throws an Error whose message is safe to show in a toast.
async function lifecycleTx(action, fn) {
  try {
    const out = await runTransaction(db, fn);
    // Our own change is pushed back to the listeners a moment after the commit
    // resolves, and the view we navigate to next renders immediately. Force the
    // next read of anything a lifecycle write can touch to go to the server, so
    // that view can never draw the pre-write state.
    Store.markStale("permits", "isolations", "equipment");
    return out;
  } catch (e) {
    if (e instanceof GateError) throw e;
    if (isUnreachable(e)) throw new Error(`No connection — ${action} not recorded. Try again.`);
    if (e?.code === "permission-denied") throw new Error(`Not permitted — ${action} not recorded.`);
    throw e;
  }
}

/* -------------------- People & roles -------------------- */
// Job titles available in the app — config overrides the built-in default.
function jobTitles() { return (State.config?.jobTitles?.length ? State.config.jobTitles : DEFAULT_JOB_TITLES); }
// Department names from config (kept exactly as configured — never recreated here).
function departmentNames() { return (State.config?.departments || DEFAULT_CONFIG.departments).map((d) => d.name); }

// Identity meta stamped alongside a person's name on permits / certificates.
function myMeta() {
  const p = State.profile || {};
  return { jobTitle: p.jobTitle || "", department: p.department || "", employeeNumber: p.employeeNumber || "" };
}
function userMeta(u) {
  u = u || {};
  return { jobTitle: u.jobTitle || u.position || "", department: u.department || "", employeeNumber: u.employeeNumber || "" };
}
// "Full Name / Job Title / Department / Employee No." — blank parts skipped.
function personText(name, meta) {
  const parts = [name, meta?.jobTitle, meta?.department, meta?.employeeNumber]
    .map((x) => (x == null ? "" : String(x)).trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : "—";
}
// HTML-escaped variant for on-screen rendering.
function personHTML(name, meta) { return esc(personText(name, meta)); }
// <option> list helper that always keeps the current value selectable.
function optionList(items, selected) {
  const arr = [...items];
  if (selected && !arr.includes(selected)) arr.unshift(selected);
  return `<option value="">Select…</option>` + arr.map((x) => `<option ${x === selected ? "selected" : ""}>${esc(x)}</option>`).join("");
}

const TYPE_CLASS = { general: "permit-type-general", hot: "permit-type-hot", loto: "permit-type-loto", confined: "permit-type-confined" };
const TYPE_DOT = { general: "var(--steel)", hot: "var(--red)", loto: "var(--amber)", confined: "var(--green)" };

const STATUS_LABEL = { draft: "Draft", submitted: "Submitted", awaitingIsolation: "Awaiting Isolation",
  // "expired" is the stored status of an auto-rejected permit. It is never
  // labelled "Rejected": a rejection is a person's decision with a reason
  // attached, and a timeout is neither. See the Auto-rejection notes above.
  active: "Active", extended: "Extended", closed: "Closed", rejected: "Rejected", expired: "Auto-rejected",
  isolated: "Isolated", pending: "Isolation Pending", trialRun: "Trial Run", available: "Available",
  assigned: "Assigned", removalPending: "De-isolation Pending", removed: "Removed" };

function badge(status) {
  return `<span class="badge-st st-${status}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  newdoc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7.5 12 3 3 7.5v9L12 21l9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.5L3 11a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h5l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  doccheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m8.5 14.5 2 2 4-4"/></svg>',
  // Locks to apply (closed shackle, plus) and locks to remove (open shackle) —
  // deliberately a family with ICON.lock, which marks equipment already isolated.
  lockplus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M12 14v4M10 16h4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>'
};

// Relative "time ago" for the notifications panel.
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60); if (h < 24) return h + " h ago";
  return Math.floor(h / 24) + " d ago";
}

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast " + type; t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

let _modalKeydown = null;
function modal({ title, body, footer = "", wide = false }) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="mhead"><h3>${esc(title)}</h3><button class="x" data-close aria-label="Close">&times;</button></div>
    <div class="mbody">${body}</div>
    ${footer ? `<div class="mfoot">${footer}</div>` : ""}
  </div></div>`;
  root.querySelector("[data-close]").onclick = closeModal;
  root.querySelector(".modal-bg").onclick = (e) => { if (e.target.classList.contains("modal-bg")) closeModal(); };
  // Keyboard support: Escape closes; Tab is trapped within the dialog.
  if (_modalKeydown) document.removeEventListener("keydown", _modalKeydown);
  _modalKeydown = (e) => {
    if (e.key === "Escape") return closeModal();
    if (e.key !== "Tab") return;
    const f = $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root)
      .filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", _modalKeydown);
  // Focus the first useful field (not the close button) once painted.
  setTimeout(() => {
    const el = root.querySelector(".mbody input,.mbody select,.mbody textarea,.mfoot [data-ok],.mfoot button") || root.querySelector(".modal");
    el?.focus?.();
  }, 0);
  return root.querySelector(".modal");
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  if (_modalKeydown) { document.removeEventListener("keydown", _modalKeydown); _modalKeydown = null; }
}

function confirmBox(title, message, okLabel, onOk, danger = false) {
  modal({ title, body: `<p style="margin:.2rem 0 0;color:var(--ink-2)">${esc(message)}</p>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button>
             <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(okLabel)}</button>` });
  $("#modal-root [data-c]").onclick = closeModal;
  $("#modal-root [data-ok]").onclick = async () => { try { await onOk(); } catch (e) { toast(e.message || "Error", "err"); } };
}

/* -------------------- 3. Auth / bootstrap -------------------- */
window.addEventListener("online", () => updateOfflineBar());
window.addEventListener("offline", () => updateOfflineBar());

// Auto-update: the service worker serves the app stale-while-revalidate, so a
// new deploy is applied on the next launch on its own. When the main code
// changes it also messages us here, and we surface a non-intrusive banner so
// the user can reload right away — never automatically, so an in-progress
// permit is never lost.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "UPDATE_READY") showUpdateBar();
  });
}
// Periodically nudge the service worker to revalidate the app code (and so
// detect a new deploy) during long-running sessions. Throttled to ~30 min and
// also fired when the tab/app is brought back to the foreground.
//
// This has to re-request app.js specifically: the service worker raises the
// update banner by comparing the cached and network ETags of that one URL in
// its fetch handler, so nothing else triggers a mid-session check.
// `no-cache` (not `reload`) is what we want — it forces revalidation with the
// server but still allows a 304, so an unchanged app costs a few hundred bytes
// instead of re-downloading the whole file every 30 minutes and on every
// return to the foreground.
let lastUpdateCheck = Date.now();
function checkForUpdate() {
  if (Date.now() - lastUpdateCheck < 30 * 60 * 1000) return;
  lastUpdateCheck = Date.now();
  if (navigator.serviceWorker && navigator.serviceWorker.controller)
    fetch("app.js", { cache: "no-cache" }).catch(() => {});
}
setInterval(checkForUpdate, 30 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });

function showUpdateBar() {
  if (document.getElementById("updbar")) return;
  const bar = document.createElement("div");
  bar.id = "updbar"; bar.className = "update-bar";
  bar.innerHTML = `A new version is available. <button type="button" id="updReload">Reload</button><button type="button" class="updx" id="updDismiss" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(bar);
  bar.querySelector("#updReload").onclick = () => location.reload();
  bar.querySelector("#updDismiss").onclick = () => bar.remove();
}

onAuthStateChanged(auth, async (user) => {
  State.user = user;
  // Clear any previous session's profile/role immediately. Until the new
  // user's role is confirmed from Firestore, State.profile is null so no
  // role-dependent UI (e.g. the Admin menu) can be rendered — not even for
  // a split second from a prior Admin session's stale state.
  State.profile = null;
  State.config = null;
  State.view = "dashboard";
  Notify.stop();               // tear down any previous session's listeners
  Store.stop();                // and drop the previous user's cached collections
  if (!user) return renderLogin();
  // Neutral loading screen while the role is fetched — nothing role-gated
  // is shown until the profile is fully loaded below.
  renderLoading();
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const profile = { id: user.uid, ...snap.data() };
      if (!profile.active) return renderPending();
      await loadConfig();
      // Commit the profile and render only after the role is fully loaded.
      State.profile = profile;
      // Start the listeners BEFORE the first render so the views can be served
      // from memory, and before Notify — which subscribes to them.
      Store.start(["permits", "isolations", "equipment"]);
      // Any collection changing offers the current list view a redraw.
      ["permits", "isolations", "equipment"].forEach((c) => Store.onChange(c, () => LiveView.ping()));
      renderApp();
      Notify.start();          // live in-app assignment alerts
    } else {
      // No profile yet → bootstrap or pending self-signup
      const initSnap = await getDoc(doc(db, "meta", "init"));
      if (!initSnap.exists()) return renderBootstrap(user);
      return renderCompleteProfile(user);
    }
  } catch (e) {
    renderLogin(e.message);
  }
});

async function loadConfig() {
  const c = await getDoc(doc(db, "config", "app"));
  State.config = c.exists() ? c.data() : DEFAULT_CONFIG;
}

// Neutral loading screen shown while the signed-in user's role is being
// fetched. It is intentionally free of any role-dependent UI.
function renderLoading() {
  $("#app").innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand">
      <div class="mark">${ICON.lock}</div>
      <div><div class="t1">${esc(appBranding.appName)}</div>
        <div class="t2">${esc(appBranding.company)}</div></div>
    </div>
    <div class="sub" style="display:flex;align-items:center;gap:.6rem">
      <span class="spinner" aria-hidden="true"></span>
      <span>Loading your workspace…</span>
    </div>
  </div></div>`;
}

function renderLogin(error = "") {
  let mode = "signin";
  const root = $("#app");
  const draw = () => {
    root.innerHTML = `<div class="login-wrap"><div class="login-card">
      <div class="brand">
        <div class="mark">${ICON.lock}</div>
        <div><div class="t1">${esc(appBranding.appName)}</div>
        <div class="t2">${esc(appBranding.company)}</div></div>
      </div>
      <h2>${mode === "signin" ? "Sign in" : "Create account"}</h2>
      <div class="sub">${mode === "signin" ? "Use your work email and password." : "Register — an administrator will then activate your account."}</div>
      ${error ? `<div class="err-msg">${esc(error)}</div>` : ""}
      <div id="lf"></div>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="username" placeholder="name@nrcc.com"></label>
      <label class="field"><span>Password</span><input type="password" id="pass" autocomplete="current-password" placeholder="••••••••"></label>
      ${mode === "signin" ? `<div style="text-align:right;margin:-.55rem 0 1rem"><a href="#" id="forgot" style="font-size:.82rem">Forgot password?</a></div>` : ""}
      ${mode === "signup" ? `
        <label class="field"><span>Full name <span class="req">*</span></span><input type="text" id="fname" placeholder="e.g. Fiaz Ahmed"></label>
        <div class="grid-2">
          <label class="field"><span>Department <span class="req">*</span></span><select id="fdept">${optionList(departmentNames(), "")}</select></label>
          <label class="field"><span>Job Title <span class="req">*</span></span><select id="fjob">${optionList(jobTitles(), "")}</select></label>
        </div>
        <label class="field"><span>Employee Number <span class="req">*</span></span><input type="text" id="femp" placeholder="e.g. EMP-1042"></label>` : ""}
      <button class="btn btn-accent btn-block" id="go">${mode === "signin" ? "Sign in" : "Create account"}</button>
      <div style="text-align:center;margin-top:1rem;font-size:.85rem;color:var(--muted)">
        ${mode === "signin" ? "New here?" : "Already registered?"}
        <a href="#" id="toggle">${mode === "signin" ? "Create an account" : "Sign in"}</a>
      </div>
    </div></div>`;
    $("#toggle").onclick = (e) => { e.preventDefault(); mode = mode === "signin" ? "signup" : "signin"; error = ""; draw(); };
    $("#go").onclick = submit;
    root.querySelector("#pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    const fp = $("#forgot");
    if (fp) fp.onclick = async (e) => {
      e.preventDefault();
      const email = $("#email").value.trim();
      if (!email) return toast("Enter your email above, then click Forgot password", "err");
      try { await sendPasswordResetEmail(auth, email); toast(`Password reset link sent to ${email}`, "ok"); }
      catch (err) { toast(friendlyAuthError(err), "err"); }
    };
  };
  async function submit() {
    const email = $("#email").value.trim(), pass = $("#pass").value;
    if (!email || !pass) return toast("Enter email and password", "err");
    $("#go").disabled = true;
    try {
      if (mode === "signin") {
        await signInWithEmailAndPassword(auth, email, pass);
      } else {
        const name = $("#fname").value.trim();
        const department = $("#fdept").value, jobTitle = $("#fjob").value, employeeNumber = $("#femp").value.trim();
        if (!name) { $("#go").disabled = false; return toast("Full name is required", "err"); }
        if (!department) { $("#go").disabled = false; return toast("Select your department", "err"); }
        if (!jobTitle) { $("#go").disabled = false; return toast("Select your job title", "err"); }
        if (!employeeNumber) { $("#go").disabled = false; return toast("Employee number is required", "err"); }
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        sessionStorage.setItem("signup", JSON.stringify({ name, department, jobTitle, employeeNumber }));
        // onAuthStateChanged will route to bootstrap/complete-profile
      }
    } catch (e) {
      $("#go").disabled = false;
      renderLogin(friendlyAuthError(e));
    }
  }
  draw();
}
function friendlyAuthError(e) {
  const m = (e.code || "").replace("auth/", "");
  return ({ "invalid-credential": "Incorrect email or password.", "user-not-found": "No account with that email.",
    "wrong-password": "Incorrect password.", "email-already-in-use": "That email is already registered.",
    "weak-password": "Password must be at least 6 characters.", "invalid-email": "That email looks invalid.",
    "network-request-failed": "Network error — you appear to be offline. Sign in once while online first." }[m]) || (e.message || "Sign-in failed.");
}

function renderBootstrap(user) {
  const su = JSON.parse(sessionStorage.getItem("signup") || "{}");
  const root = $("#app");
  root.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand"><div class="mark">${ICON.lock}</div>
      <div><div class="t1">First-time setup</div><div class="t2">${esc(appBranding.company)}</div></div></div>
    <div class="info-box">You are the first user. Initialising will set up the default configuration
      (permit types, lines, areas, departments) and make <b>${esc(user.email)}</b> the <b>Administrator</b>.</div>
    <label class="field"><span>Your name <span class="req">*</span></span><input type="text" id="bn" value="${esc(su.name || "")}"></label>
    <div class="grid-2">
      <label class="field"><span>Department <span class="req">*</span></span><select id="bd">${optionList(DEFAULT_CONFIG.departments.map((d) => d.name), su.department || "")}</select></label>
      <label class="field"><span>Job Title <span class="req">*</span></span><select id="bj">${optionList(DEFAULT_JOB_TITLES, su.jobTitle || "")}</select></label>
    </div>
    <label class="field"><span>Employee Number <span class="req">*</span></span><input type="text" id="be" placeholder="e.g. EMP-1042" value="${esc(su.employeeNumber || "")}"></label>
    <button class="btn btn-accent btn-block" id="binit">Initialise system as Administrator</button>
    <div style="text-align:center;margin-top:.9rem"><a href="#" id="bso">Sign out</a></div>
  </div></div>`;
  $("#bso").onclick = (e) => { e.preventDefault(); signOut(auth); };
  $("#binit").onclick = async () => {
    const name = $("#bn").value.trim(), department = $("#bd").value, jobTitle = $("#bj").value, employeeNumber = $("#be").value.trim();
    if (!name) return toast("Enter your name", "err");
    if (!department) return toast("Select your department", "err");
    if (!jobTitle) return toast("Select your job title", "err");
    if (!employeeNumber) return toast("Enter your employee number", "err");
    $("#binit").disabled = true;
    try {
      await setDoc(doc(db, "config", "app"), DEFAULT_CONFIG);
      await setDoc(doc(db, "users", user.uid), {
        name, email: user.email, role: "admin", active: true,
        department, jobTitle, employeeNumber, createdAt: nowISO()
      });
      await setDoc(doc(db, "meta", "init"), { initialisedBy: user.uid, at: nowISO() });
      sessionStorage.removeItem("signup");
      State.profile = { id: user.uid, name, role: "admin", active: true, department, jobTitle, employeeNumber };
      await loadConfig(); renderApp(); toast("System initialised", "ok");
    } catch (e) { $("#binit").disabled = false; toast(e.message, "err"); }
  };
}

async function renderCompleteProfile(user) {
  const su = JSON.parse(sessionStorage.getItem("signup") || "{}");
  // Departments and job titles come from config/app — load it so the
  // dropdowns reflect the configured lists (never invent new departments).
  if (!State.config) { try { await loadConfig(); } catch { State.config = DEFAULT_CONFIG; } }
  // The sign-up screen already collects name, department, job title and
  // employee number — finalise the profile directly, no second form.
  if (su.name && su.department && su.jobTitle && su.employeeNumber) {
    try {
      await setDoc(doc(db, "users", user.uid), {
        name: su.name, email: user.email, role: "requester", active: false,
        department: su.department, jobTitle: su.jobTitle, employeeNumber: su.employeeNumber, createdAt: nowISO()
      });
      sessionStorage.removeItem("signup");
      return renderPending();
    } catch (e) { toast(e.message, "err"); /* fall through to the manual form */ }
  }
  const root = $("#app");
  root.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand"><div class="mark">${ICON.lock}</div>
      <div><div class="t1">Complete your profile</div><div class="t2">${esc(appBranding.company)}</div></div></div>
    <div class="info-box">Your account will be created as <b>pending</b>. An administrator must activate it and assign your role before you can raise permits.</div>
    <label class="field"><span>Your name <span class="req">*</span></span><input type="text" id="cn" value="${esc(su.name || "")}"></label>
    <div class="grid-2">
      <label class="field"><span>Department <span class="req">*</span></span><select id="cd">${optionList(departmentNames(), su.department || "")}</select></label>
      <label class="field"><span>Job Title <span class="req">*</span></span><select id="cj">${optionList(jobTitles(), su.jobTitle || "")}</select></label>
    </div>
    <label class="field"><span>Employee Number <span class="req">*</span></span><input type="text" id="ce" placeholder="e.g. EMP-1042" value="${esc(su.employeeNumber || "")}"></label>
    <button class="btn btn-accent btn-block" id="csave">Submit for approval</button>
    <div style="text-align:center;margin-top:.9rem"><a href="#" id="cso">Sign out</a></div>
  </div></div>`;
  $("#cso").onclick = (e) => { e.preventDefault(); signOut(auth); };
  $("#csave").onclick = async () => {
    const name = $("#cn").value.trim(), department = $("#cd").value, jobTitle = $("#cj").value, employeeNumber = $("#ce").value.trim();
    if (!name) return toast("Enter your name", "err");
    if (!department) return toast("Select your department", "err");
    if (!jobTitle) return toast("Select your job title", "err");
    if (!employeeNumber) return toast("Enter your employee number", "err");
    try {
      await setDoc(doc(db, "users", user.uid), {
        name, email: user.email, role: "requester", active: false,
        department, jobTitle, employeeNumber, createdAt: nowISO()
      });
      sessionStorage.removeItem("signup"); renderPending();
    } catch (e) { toast(e.message, "err"); }
  };
}

function renderPending() {
  $("#app").innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand"><div class="mark">${ICON.lock}</div>
      <div><div class="t1">Account pending</div><div class="t2">${esc(appBranding.company)}</div></div></div>
    <p style="color:var(--ink-2)">Your account is awaiting administrator approval. Please check back later.</p>
    <button class="btn btn-ghost btn-block" id="pso">Sign out</button></div></div>`;
  $("#pso").onclick = () => signOut(auth);
}

/* -------------------- 4. App shell & router -------------------- */
// True only when a profile with a confirmed Admin role is loaded.
// Used to gate every Admin-only menu item and view.
function isAdmin() { return State.profile?.role === "admin"; }

function navItems() {
  // Guard: never build navigation before the role is confirmed.
  if (!State.profile) return [];
  const items = [
    { v: "dashboard", label: "Dashboard", icon: ICON.home },
    { v: "new", label: "New Permit", icon: ICON.newdoc },
    { v: "permits", label: "Permit Register", icon: ICON.list },
    { v: "equipment", label: "Equipment", icon: ICON.cube }
  ];
  if (isAdmin()) items.push({ v: "admin", label: "Administration", icon: ICON.gear });
  return items;
}

function renderApp() {
  const p = State.profile;
  $("#app").innerHTML = `
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="logo"><div class="mark">${ICON.lock}</div>
          <div><b>NRCC PTW</b><small>Permit to Work</small></div></div>
        <nav id="nav"></nav>
        <div class="foot">${esc(appBranding.company)} · ${esc(appBranding.site)}<br>v1.0</div>
      </aside>
      <header class="topbar">
        <h1 id="topTitle">Dashboard</h1>
        <div class="spacer"></div>
        <div class="bell-wrap">
          <button class="btn btn-ghost btn-sm bell-btn" id="bell" title="Notifications" aria-label="Notifications">
            ${ICON.bell}<span class="bell-badge hidden" id="bellBadge"></span>
          </button>
          <div class="notif-panel hidden" id="notifPanel"></div>
        </div>
        <div class="who">
          <div style="text-align:right"><div style="font-weight:700">${esc(p.name)}</div>
            <span class="role-chip">${esc(p.role)}</span></div>
          <div class="avatar">${initials(p.name)}</div>
          <button class="btn btn-ghost btn-sm" id="logout" title="Sign out" aria-label="Sign out">${ICON.out}</button>
        </div>
      </header>
      <main class="main" id="main"></main>
      <nav class="bottomnav" id="bnav"></nav>
    </div>`;
  const shortLabels = { dashboard: "Home", new: "New", permits: "Register", equipment: "Equipment", admin: "Admin" };
  const nav = $("#nav"), bnav = $("#bnav");
  navItems().forEach((it) => {
    const b = document.createElement("button");
    b.className = "navitem"; b.dataset.v = it.v;
    b.innerHTML = `${it.icon}<span>${it.label}</span><span class="badge hidden" data-badge></span>`;
    b.onclick = () => go(it.v);
    nav.appendChild(b);
    const m = document.createElement("button");
    m.className = "bn-item"; m.dataset.v = it.v;
    m.innerHTML = `${it.icon}<span>${shortLabels[it.v] || it.label}</span>`;
    m.onclick = () => go(it.v);
    bnav.appendChild(m);
  });
  $("#logout").onclick = () => signOut(auth);
  updateOfflineBar();
  Notify.mountUI();
  // The dashboard refreshes the badge itself from the permits it already
  // loaded, so only pay for a separate fetch when landing elsewhere.
  const landing = State.view || "dashboard";
  go(landing);
  if (landing !== "dashboard") refreshPendingBadge();
}

function go(view, params = {}) {
  // Hard guard: the Administration view is Admin-only. Even if navigation is
  // triggered some other way, a non-Admin can never render Admin controls.
  if (view === "admin" && !isAdmin()) view = "dashboard";
  State.view = view; State.params = params;
  LiveView.reset();            // the outgoing view stops refreshing itself
  const hv = ["isolations", "isodetail", "detail"].includes(view) ? "permits" : view;
  $$(".navitem,.bn-item").forEach((n) => n.classList.toggle("active", n.dataset.v === hv));
  const titles = { dashboard: "Dashboard", new: "New Permit", permits: "Permit Register", isolations: "Isolation Certificates", isodetail: "Isolation Certificate", equipment: "Equipment", admin: "Administration", detail: "Permit Detail" };
  $("#topTitle").textContent = titles[view] || "";
  const m = $("#main"); m.scrollTop = 0;
  ({ dashboard: viewDashboard, new: viewNewPermit, permits: viewPermits, isolations: viewIsolations, isodetail: viewIsolationDetail, equipment: viewEquipment, admin: viewAdmin, detail: viewPermitDetail }[view] || viewDashboard)(m);
}

function updateOfflineBar() {
  const main = $("#main"); if (!main) return;
  let bar = $("#offbar");
  if (!navigator.onLine) {
    if (!bar) { bar = document.createElement("div"); bar.id = "offbar"; bar.className = "offline-bar";
      bar.textContent = "Offline — changes are saved on this device and will sync when you reconnect.";
      main.prepend(bar); }
  } else { bar?.remove(); }
}

/* -------------------- Live collection store --------------------
   Every view used to re-download whole collections with getDocs, so opening the
   dashboard, then the register, then the dashboard again paid for the same
   documents three times. At a few hundred permits that is thousands of reads
   per sign-in — enough to exhaust a day's quota and to make every page wait on
   the network before it can draw anything.

   The app was already holding live onSnapshot listeners on permits and
   isolations to drive the notification bell, then throwing that data away and
   re-fetching it anyway. This keeps it instead: one listener per collection,
   feeding an in-memory copy that Firestore keeps current. Reads after sign-in
   cost nothing and render immediately, and the copy is pushed-to on every
   change rather than expiring on a timer, so it is never knowingly out of date.

   HEALTH IS THE WHOLE POINT. A listener that quietly drops would leave the
   store frozen with no visible symptom — stale data that still looks live. So
   a collection is served from memory ONLY while its listener is attached and
   has delivered; on any error, or before the first delivery, callers fall
   straight back to a direct getDocs. Falling back is exactly the old
   behaviour: slower and costlier, never wrong. */
const Store = {
  data: {},        // coll -> array of {id, ...doc}
  live: {},        // coll -> listener attached AND has delivered at least once
  stale: {},       // coll -> next read must bypass memory (see markStale)
  watchers: {},    // coll -> [fn(docs, isFirstDelivery)]
  subs: [],

  start(colls) {
    this.stop();
    for (const coll of colls) {
      this.live[coll] = false;
      const unsub = onSnapshot(collection(db, coll), (snap) => {
        const first = !this.live[coll];
        this.data[coll] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this.live[coll] = true;
        this.stale[coll] = false;
        (this.watchers[coll] || []).forEach((fn) => { try { fn(this.data[coll], first); } catch (e) { console.warn("Store watcher failed", coll, e); } });
      }, (err) => {
        // Stop trusting this collection. Views keep working via getDocs.
        this.live[coll] = false;
        console.warn(`Store: ${coll} listener lost — falling back to direct reads`, err);
      });
      this.subs.push(unsub);
    }
  },
  stop() {
    this.subs.forEach((u) => { try { u(); } catch {} });
    this.subs = [];
    this.data = {}; this.live = {}; this.stale = {}; this.watchers = {};
  },
  // The in-memory copy, or null when it must not be trusted.
  get(coll) {
    return (this.live[coll] && !this.stale[coll]) ? this.data[coll] : null;
  },
  // Force the next read of these collections to hit the server. Used after a
  // write: the listener push that carries our own change may land a moment
  // after the write resolves, and a view rendered in that gap would still show
  // the pre-write state.
  markStale(...colls) { colls.forEach((c) => { this.stale[c] = true; }); },
  onChange(coll, fn) {
    (this.watchers[coll] = this.watchers[coll] || []).push(fn);
    // A listener that has already delivered must not leave a late subscriber
    // waiting for the next change to catch up.
    if (this.live[coll]) { try { fn(this.data[coll], true); } catch (e) { console.warn("Store watcher failed", coll, e); } }
  }
};

/* -------------------- Live view refresh --------------------
   The Store keeps the data current, but a screen drawn once stays drawn: an
   Issuer watching the dashboard would not see a permit arrive, and the
   "Awaiting your approval" count sat stale until they navigated away and back.
   Before the Store existed this was expensive to fix — refreshing meant
   re-downloading every collection on a timer, which is what exhausted the read
   quota. Now the fresh data is already in memory, so redrawing is nearly free.

   Deliberately limited to the LIST views (dashboard and the three registers).
   Detail pages are left alone: they are where someone stands about to approve
   or de-isolate, and repainting the buttons under a thumb is worse than showing
   a few-second-old record — the approval transaction, not the screen, is what
   guarantees the decision is made on current data.

   Three rules keep a repaint from being disruptive:
     - never while a dialog is open, so nothing moves mid-decision
     - only the view that is still on screen (a token, so a slow refresh from a
       screen already navigated away from cannot write over its replacement)
     - debounced, so a burst of changes causes one repaint rather than ten   */
const LiveView = {
  fn: null, token: 0, timer: null,

  // Called by the router before a new view renders: forget the old view's
  // refresh and invalidate anything still in flight for it.
  reset() {
    this.fn = null; this.token++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this.token;
  },
  // A view registers how to redraw itself. `token` is the value it captured
  // when it started, so a view that finished loading after the user moved on
  // silently declines to register.
  bind(token, fn) {
    if (token !== this.token) return;
    this.fn = async () => { if (token === this.token) await fn(); };
  },
  // Data changed underneath.
  ping() {
    if (!this.fn) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      const fn = this.fn;
      if (!fn) return;
      // A dialog open means someone is part-way through a decision.
      if ($("#modal-root")?.innerHTML.trim()) return;
      try { await fn(); } catch (e) { console.warn("Live refresh failed", e); }
    }, 400);
  }
};

/* -------------------- In-app assignment alerts --------------------
   Free, in-app only: two live Firestore listeners (permits + isolations)
   detect every point in the lifecycle where work is handed to a person,
   then play ONE short sound + raise a bell badge + toast. No backend, no
   Cloud Functions, no Firebase plan change. Per-user "seen" signatures
   (localStorage) stop repeats across reloads; the very first sync on a
   brand-new device is primed silently so history does not ding.
   Limitation (by design): fires only while the app is open. */
const Notify = {
  subs: [], seen: new Set(), items: [], primed: {}, wasEmpty: true,
  audioCtx: null, unlocked: false, panelOpen: false,

  _key() { return `ptw_seen_alerts_${State.profile?.id || "anon"}`; },
  _load() {
    try { this.seen = new Set(JSON.parse(localStorage.getItem(this._key()) || "[]")); }
    catch { this.seen = new Set(); }
    this.wasEmpty = this.seen.size === 0;
  },
  _save() {
    // Cap the stored set so it cannot grow without bound.
    try { localStorage.setItem(this._key(), JSON.stringify([...this.seen].slice(-800))); } catch {}
  },

  start() {
    this.stop();
    this._load();
    this.items = []; this.primed = {}; this.panelOpen = false;
    this._unlockAudio();
    this._watch("permits", (d) => this.permitEvents(d));
    this._watch("isolations", (d) => this.isoEvents(d));
    // Overdue is time-based (no doc change), so re-check on a light timer.
    this._timer = setInterval(() => this._recheckOverdue(), 5 * 60 * 1000);
    this.badge();
  },
  stop() {
    this.subs.forEach((u) => { try { u(); } catch {} });
    this.subs = [];
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  // Rides the Store's listener rather than opening a second one on the same
  // collection — the alerts and the cached copy are driven by the same push.
  _watch(coll, extract) {
    Store.onChange(coll, (docs) => {
      const first = !this.primed[coll];
      const silent = this.wasEmpty && first;   // brand-new device → seed quietly
      const fired = [];
      let added = false;
      for (const d of docs) {
        for (const ev of extract(d)) {
          if (this.seen.has(ev.sig)) continue;
          this.seen.add(ev.sig); added = true;
          if (!silent) fired.push(ev);
        }
      }
      this.primed[coll] = true;
      // Only touch localStorage when the seen-set actually grew. This used to
      // run on every snapshot — a synchronous stringify + write of up to 800
      // entries, on the main thread, every time anyone saved anything.
      if (added) this._save();
      if (fired.length) this._fire(fired);
    });
  },

  _recheckOverdue() {
    // Overdue is time-based: no document changes, so no listener fires. Re-run
    // the check against the copy the Store already holds — this used to
    // re-download the whole permits collection every five minutes for the
    // lifetime of the session, purely to compare timestamps.
    const permits = Store.get("permits");
    if (!permits) return;      // listener down — skip a tick rather than refetch
    const fired = [];
    permits.forEach((p) => {
      for (const ev of this.permitEvents(p)) {
        if (ev.kind !== "overdue" || this.seen.has(ev.sig)) continue;
        this.seen.add(ev.sig); fired.push(ev);
      }
    });
    if (fired.length) { this._save(); this._fire(fired); }
  },

  /* ---- which events apply to THIS user for a given doc ---- */
  permitEvents(p) {
    const me = State.profile?.id, role = State.profile?.role;
    const isIssuer = role === "issuer" || role === "admin";
    const isIsolator = role === "isolator" || role === "admin";
    const owner = p.requester?.uid === me;
    const no = p.permitNo || p.id, tag = p.equipmentTag || "the equipment";
    const to = { view: "detail", params: { id: p.id } };
    const out = [];
    // E1 — submitted → Issuer(s)
    if (p.status === "submitted" && isIssuer && p.requester?.uid !== me)
      out.push({ sig: `p:${p.id}:submitted`, text: `New permit ${no} submitted by ${p.requester?.name || "a requester"} — review & approve.`, ...to });
    // E3 — activated → Requester
    if ((p.status === "active" || p.status === "extended") && owner && p.approval?.issuerUid !== me)
      out.push({ sig: `p:${p.id}:active`, text: `Permit ${no} is now ACTIVE — work may start on ${tag}.`, ...to });
    // E4 — rejected → Requester
    if (p.status === "rejected" && owner && p.rejection?.by !== me)
      out.push({ sig: `p:${p.id}:rejected`, text: `Permit ${no} was returned by ${p.rejection?.byName || "the Issuer"}.${p.rejection?.reason ? " Reason: " + p.rejection.reason : ""}`, ...to });
    // E5 — work complete. A NON-isolated permit can be closed by the Issuer
    // right away. An ISOLATED permit must be de-isolated first (closing is
    // blocked until then), so here we only prompt the Isolator; the Issuer is
    // alerted to close later — by E9, when de-isolation is confirmed.
    if (p.workCompletion && p.workCompletion.by !== me) {
      const sig = `p:${p.id}:wc:${p.workCompletion.timestamp || ""}`;
      if (!p.isolationRef && isIssuer) out.push({ sig, text: `Work complete under ${no} on ${tag} — ready to close.`, ...to });
      else if (p.isolationRef && isIsolator) out.push({ sig: sig + ":deiso", text: `Work complete under ${no} — de-isolation needed on ${tag}.`, ...to });
    }
    // E7 — closed → Requester
    if (p.status === "closed" && owner && p.closure?.by !== me)
      out.push({ sig: `p:${p.id}:closed`, text: `Permit ${no} closed — ${tag} returned to service.`, ...to });
    // E8 — overdue → Issuer(s) + Requester
    if (isOverdue(p) && (isIssuer || owner)) {
      const end = permitEnd(p);
      out.push({ sig: `p:${p.id}:overdue:${end || ""}`, kind: "overdue", text: `Permit ${no} is overdue — extend or close.`, ...to });
    }
    return out;
  },

  isoEvents(i) {
    const me = State.profile?.id, role = State.profile?.role;
    const isIsolator = role === "isolator" || role === "admin";
    const no = i.isoNo || i.id, tag = i.equipmentTag || "the equipment";
    const to = { view: "isodetail", params: { id: i.id } };
    const out = [];
    // E2 — isolation assigned → the named Isolator
    if (i.status === "assigned" && i.assignedTo?.uid === me && i.assignedBy?.uid !== me)
      out.push({ sig: `i:${i.id}:assigned:${i.assignedAt || ""}`, text: `Isolation ${no} assigned to you — confirm isolation on ${tag}.`, ...to });
    // E6 — de-isolation → named Isolator, or any Isolator if unassigned
    if (i.status === "removalPending") {
      const named = i.removalAssignedTo?.uid;
      if (named ? named === me : isIsolator)
        out.push({ sig: `i:${i.id}:removalPending:${i.removalAssignedAt || ""}`, text: `De-isolation of ${no} assigned to you — remove locks on ${tag}.`, ...to });
    }
    // E10-13 — trial run. Only what the certificate alone can answer: whether
    // a crew's consent is outstanding needs the permit list, and that half is
    // carried by the dashboard banner and the crew's own permit instead.
    const tr = i.trialRun;
    if (tr && tr.status === "requested" && (role === "issuer" || role === "admin"))
      out.push({ sig: `i:${i.id}:trialReq:${tr.requestedAt || ""}`, text: `Trial run requested on ${tag} (${no}) — crews are clearing it.`, ...to });
    if (tr && tr.status === "approved" && isIsolator)
      out.push({ sig: `i:${i.id}:trialOk:${tr.issuerApproval?.at || ""}`, text: `Trial run authorised on ${tag} (${no}) — de-isolate when every crew is clear.`, ...to });
    // The two that matter most: the plant is live.
    if (isTrialEnergised(i) && isIsolator)
      out.push({ sig: `i:${i.id}:trialLive:${tr?.deisolatedAt || ""}`, kind: "overdue", text: `TRIAL RUN in progress — ${tag} is ENERGISED. Re-isolate when it is finished.`, ...to });
    if (tr && tr.completedBy && isIsolator)
      out.push({ sig: `i:${i.id}:trialDone:${tr.completedAt || ""}`, kind: "overdue", text: `The crew has finished the trial run on ${tag} (${no}) — re-apply the locks.`, ...to });
    // E9 — de-isolation confirmed (locks removed) → Issuer(s) can now close the
    // permit(s). This is the moment closing stops being blocked.
    const ids = i.attachedPermitIds || [];
    if (i.status === "removed" && ids.length && (role === "issuer" || role === "admin") && i.removalConfirmedBy?.uid !== me) {
      const dest = ids.length === 1 ? { view: "detail", params: { id: ids[0] } } : { view: "isodetail", params: { id: i.id } };
      out.push({ sig: `i:${i.id}:removed:${i.removedAt || ""}`, text: `De-isolation complete on ${tag} (${no}) — permit${ids.length > 1 ? "s" : ""} can now be closed.`, ...dest });
    }
    return out;
  },

  /* ---- output: sound + badge + toast + panel ---- */
  _fire(events) {
    events.forEach((ev) => this.items.unshift({ text: ev.text, view: ev.view, params: ev.params, ts: Date.now(), read: false }));
    this.items = this.items.slice(0, 50);
    this.badge();
    this.ding();                                   // one sound per batch
    if (events.length === 1) toast("🔔 " + events[0].text);
    else toast(`🔔 ${events.length} new alerts — tap the bell to view.`);
    if (this.panelOpen) this.renderPanel();
  },

  ding() {
    // Web Audio two-tone chime — no asset needed. Silent-safe if blocked.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      const t0 = ctx.currentTime;
      [880, 1174.66].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        const t = t0 + i * 0.13;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + 0.24);
      });
    } catch { /* sound unavailable — badge still updates */ }
  },
  _unlockAudio() {
    // Browsers require a user gesture before audio can play; resume on the
    // first interaction so the next alert can sound.
    if (this.unlocked) return;
    const resume = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx && !this.audioCtx) this.audioCtx = new Ctx();
        if (this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
      } catch {}
      this.unlocked = true;
      ["click", "touchstart", "keydown"].forEach((e) => window.removeEventListener(e, resume));
    };
    ["click", "touchstart", "keydown"].forEach((e) => window.addEventListener(e, resume, { passive: true }));
  },

  /* ---- bell UI ---- */
  mountUI() {
    const bell = $("#bell");
    if (!bell) return;
    bell.onclick = (e) => { e.stopPropagation(); this.togglePanel(); };
    document.addEventListener("click", (e) => {
      if (this.panelOpen && !e.target.closest("#notifPanel") && !e.target.closest("#bell")) this.closePanel();
    });
    this.badge();
  },
  badge() {
    const b = $("#bellBadge"); if (!b) return;
    const n = this.items.filter((i) => !i.read).length;
    b.textContent = n > 9 ? "9+" : String(n);
    b.classList.toggle("hidden", n === 0);
  },
  togglePanel() { this.panelOpen ? this.closePanel() : this.openPanel(); },
  openPanel() {
    this.panelOpen = true;
    this.items.forEach((i) => i.read = true);   // opening clears the badge
    this.badge();
    this.renderPanel();
    const p = $("#notifPanel"); if (p) p.classList.remove("hidden");
  },
  closePanel() {
    this.panelOpen = false;
    const p = $("#notifPanel"); if (p) p.classList.add("hidden");
  },
  renderPanel() {
    const panel = $("#notifPanel"); if (!panel) return;
    if (!this.items.length) { panel.innerHTML = `<div class="notif-empty">No notifications yet.</div>`; return; }
    panel.innerHTML =
      `<div class="notif-head"><span>Notifications</span><button type="button" id="notifClear" class="notif-clear">Clear all</button></div>` +
      this.items.map((it, ix) => `<button type="button" class="notif-item" data-nix="${ix}">
        <span class="notif-dot"></span>
        <span class="notif-body"><span class="notif-text">${esc(it.text)}</span><span class="notif-time">${timeAgo(it.ts)}</span></span>
      </button>`).join("");
    panel.querySelector("#notifClear").onclick = (e) => { e.stopPropagation(); this.items = []; this.badge(); this.renderPanel(); };
    panel.querySelectorAll(".notif-item").forEach((b) => b.onclick = () => {
      const it = this.items[+b.dataset.nix]; if (!it) return;
      this.closePanel(); go(it.view, it.params);
    });
  }
};

/* data fetch helpers */
// Served from the Store's live copy when that copy is trustworthy, otherwise
// straight from the server. Pass { fresh: true } to require a server read even
// when the copy is good — used by the checks that gate a state change, so a
// safety decision is never taken on anything but data read at that moment.
//
// The ARRAY is a copy, so callers may filter/sort/push freely. The DOCUMENTS in
// it are shared with the Store: treat them as read-only. To change one, write
// it to Firestore and let the listener bring it back, or replace the entry in
// your own array with a modified copy — never assign onto it in place.
async function fetchAll(coll, { fresh = false } = {}) {
  if (!fresh) {
    const cached = Store.get(coll);
    if (cached) return cached.slice();
  }
  const snap = await getDocs(collection(db, coll));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function fetchPermits(o) { const a = await fetchAll("permits", o); a.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || "")); return a; }
// Active equipment only. Archived items (superseded by a data refresh) stay in
// the collection so historical permits/certificates still resolve by
// equipmentRef via getDoc, but are hidden from the active register and pickers.
async function fetchEquipment(o) { const a = (await fetchAll("equipment", o)).filter((e) => !e.archived); a.sort((x, y) => (x.tag || "").localeCompare(y.tag || "")); return a; }
async function fetchIsolations(o) { const a = await fetchAll("isolations", o); a.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || "")); return a; }
async function activeUsers() { const u = await fetchAll("users"); return u.filter((x) => x.active).sort((a, b) => (a.name || "").localeCompare(b.name || "")); }
// Only active users holding the Isolator role — used for isolation / de-isolation assignment.
async function isolatorUsers() { return (await activeUsers()).filter((x) => x.role === "isolator"); }

// A confirmed (active) certificate is ready for de-isolation once every permit
// attached to it has had its work confirmed complete (or is otherwise closed).
// This is what makes the Isolator's de-isolation step open automatically after
// the last crew signs off — without the requester writing to the certificate.
// Permits grouped by the certificate they are attached to. Answering "is this
// certificate ready for de-isolation?" for many certificates otherwise re-scans
// the entire permit list once per certificate.
function permitsByIso(permits) {
  const m = new Map();
  for (const p of permits || []) {
    if (!p.isolationRef) continue;
    const arr = m.get(p.isolationRef);
    if (arr) arr.push(p); else m.set(p.isolationRef, [p]);
  }
  return m;
}
// `byIso` is an optional permitsByIso() index — pass it when checking several
// certificates against the same permit list.
function isoReadyForDeiso(iso, permits, byIso) {
  if (!iso || iso.status !== "active") return false;
  const att = byIso ? (byIso.get(iso.id) || []) : permits.filter((p) => p.isolationRef === iso.id);
  if (!att.length) return false;
  return att.every((p) =>
    ["closed", "rejected", "expired"].includes(p.status) ||
    (["active", "extended"].includes(p.status) && !!p.workCompletion));
}

/* -------------------- Trial run --------------------
   A trial run temporarily energises isolated equipment so the crew can prove a
   repair. Its state lives on the ISOLATION CERTIFICATE, not on the permit: the
   certificate is the thing whose locks come off and go back on, and one
   certificate may carry several crews. Holding the record on one permit — as
   the first version did — means a shared lockout can be re-isolated from a
   sibling permit, leaving the original permit's log claiming the equipment is
   still live.

     iso.trialRun     the one in flight (null when there is none)
     iso.trialRunLog  the completed / refused / cancelled ones, for audit

   The certificate STATUS deliberately stays "active" through request, consent
   and approval, and only flips to "trialRun" when the Isolator actually pulls
   the locks. Every existing gate in the app keys off `status === "active"`
   (attachment, release, de-isolation readiness, the equipment cycle), so
   keeping the flip at the physical moment means none of them need to change
   and none of them can be fooled by a trial that was only ever requested.

   Pure so they can be tested (tests/trial-run.mjs) — they read nothing and
   write nothing; the caller supplies the certificate and the permit list. */

// The request/consent/approval phase, or null when no trial is in flight.
// Anything unrecognised reads as null: an unknown value must never be treated
// as authority to energise.
function trialStage(iso) {
  const st = iso && iso.trialRun && iso.trialRun.status;
  return ["requested", "approved", "energised"].includes(st) ? st : null;
}

// Is the equipment live RIGHT NOW? "approved" is deliberately false — approval
// authorises the Isolator to pull the locks, it does not pull them. A
// certificate whose own status says trialRun counts as energised whatever the
// sub-document says: that is the state written by the first version of this
// feature, and a stale record must never make live equipment look isolated.
function isTrialEnergised(iso) {
  return !!iso && (trialStage(iso) === "energised" || iso.status === "trialRun");
}

// The crews that must clear before the equipment may be energised: every OTHER
// permit on the certificate whose crew is still on the tools. Confirming work
// complete is the requester's own declaration that the job is finished and the
// equipment is safe to return to service, so those crews are not asked again —
// waiting on them would delay the trial without learning anything new. Permits
// still waiting on isolation are not asked either: that crew never started.
// (Excluded crews are not left in the dark — the certificate still carries the
// trial, so they see the energised state on their own permit.)
function trialConsentTargets(iso, permits, requestingPermitId) {
  // Without an id there is nothing to match against, and `p.isolationRef ===
  // undefined` would quietly collect every permit attached to NO certificate
  // and present them as this lockout's crew.
  if (!iso || !iso.id) return [];
  return (permits || []).filter((p) =>
    p.isolationRef === iso.id &&
    p.id !== requestingPermitId &&
    ["active", "extended"].includes(p.status) &&
    !p.workCompletion);
}

// Who still has to answer. Derived from the LIVE permit list rather than from
// the stored consent array, so a crew attached to the certificate after the
// consents were collected shows up as outstanding instead of being missed.
function trialConsentState(iso, permits) {
  const t = iso && iso.trialRun;
  if (!t) return { required: [], given: [], refused: [], outstanding: [] };
  const required = trialConsentTargets(iso, permits, t.permitId);
  // The requester's own entry records who asked; it is not an answer, and it
  // can never stand in for another crew's.
  const answered = new Map();
  for (const c of t.consents || [])
    if (c && c.permitId && (c.decision === "consent" || c.decision === "refuse"))
      answered.set(c.permitId, c.decision);
  const given = [], refused = [], outstanding = [];
  for (const p of required) {
    const d = answered.get(p.id);
    if (d === "consent") given.push(p);
    else if (d === "refuse") refused.push(p);
    else outstanding.push(p);
  }
  return { required, given, refused, outstanding };
}

/* ---- Trial runs as work, so they cannot be forgotten ----
   Everything above makes a trial run correct. None of it makes anyone LOOK.
   A trial that is started and forgotten leaves equipment energised, and until
   these queues existed the only way to find out was to open that one permit. */

// How long equipment may sit energised before the dashboard treats it as an
// alarm rather than a queue. A trial run proves a repair — it is minutes of
// work. An hour means it was forgotten, or something went wrong.
const TRIAL_LIVE_ALERT_HRS = 1;
// A trial run longer than a shift is not a trial run. The estimate is the
// crew's own, and it is what the overrun alarm is measured against, so it is
// capped — otherwise a large enough figure silences the alarm entirely.
const TRIAL_MAX_MINUTES = 480;

// How long a trial has been live against how long the crew said it would take.
// A fixed threshold treats a two-minute seal check and a half-hour commissioning
// run the same; asking the crew up front lets the alarm mean something. When
// they gave no figure, TRIAL_LIVE_ALERT_HRS stands in.
// `now` is passed rather than read so this is testable.
function trialOverrun(iso, now) {
  const t = iso && iso.trialRun;
  if (!t || !t.deisolatedAt) return null;
  const started = Date.parse(t.deisolatedAt);
  const at = Date.parse(now || nowISO());
  if (!isFinite(started) || !isFinite(at)) return null;
  const asked = Number(t.expectedMinutes);
  const expected = asked > 0 ? Math.min(Math.round(asked), TRIAL_MAX_MINUTES) : TRIAL_LIVE_ALERT_HRS * 60;
  const elapsed = Math.floor((at - started) / 60000);
  return { expected, elapsed, stated: asked > 0, over: elapsed > expected };
}

const TRIAL_TASK = {
  reIsolate: { label: "ENERGISED — re-isolate", who: "Isolator", tone: "alert" },
  energise:  { label: "Authorised — de-isolate for the trial", who: "Isolator", tone: "warn" },
  authorise: { label: "All crews cleared — authorise", who: "Issuer", tone: "warn" },
  consent:   { label: "Waiting on crews to clear", who: "Crews", tone: "calm" }
};

// Every certificate whose trial run is waiting on somebody, worst first. `since`
// is when it landed on that person's desk, so the age shown beside it is the
// time THEY have had it, not the age of the trial.
function trialTasks(isolations, permits) {
  const byIso = permitsByIso(permits || []);
  const out = [];
  for (const i of isolations || []) {
    const t = i.trialRun;
    // Energised first and unconditionally — including a certificate energised
    // by the earlier flow, which has no sub-document to read a stage from.
    if (isTrialEnergised(i)) {
      out.push({ iso: i, kind: "reIsolate", done: !!t?.completedBy,
                 since: t?.deisolatedAt || t?.requestedAt || i.updatedAt || null });
      continue;
    }
    const st = trialStage(i);
    if (!st) continue;
    if (st === "approved") { out.push({ iso: i, kind: "energise", since: t.issuerApproval?.at || t.requestedAt }); continue; }
    const c = trialConsentState(i, byIso.get(i.id) || []);
    out.push({ iso: i, kind: c.outstanding.length ? "consent" : "authorise",
               outstanding: c.outstanding.length, since: t.requestedAt });
  }
  const order = { reIsolate: 0, energise: 1, authorise: 2, consent: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] ||
    String(a.since || "").localeCompare(String(b.since || "")));
}

// Which of those a given role should be shown. Energised equipment is
// everybody's business — a live machine is a hazard whether or not you are the
// one who has to act on it. The rest is offered to the roles that can act.
function trialTasksFor(tasks, role) {
  const runs = ["issuer", "admin", "isolator"].includes(role);
  return (tasks || []).filter((t) => t.kind === "reIsolate" || runs);
}

// Why hand-back cannot proceed on this certificate, or null if it may. Hand-back
// is the point of no return — the locks come off for good — so a trial run at
// ANY stage holds it, not only an energised one: taking the locks off while a
// crew is waiting to energise would leave a live request pointing at a dead
// certificate, and that crew would still be reading "trial run authorised".
// `verb` names the action for the message ("de-isolating", "releasing").
function handbackHold(iso, verb) {
  if (!iso) return null;
  if (isTrialEnergised(iso)) return "The equipment is energised for a trial run — re-isolate before " + verb + ".";
  if (iso.trialRun) return "A trial run is in progress on this certificate — finish or cancel it before " + verb + ".";
  return null;
}

// The single authority on "may this certificate be energised right now". The
// Isolator's transaction recomputes this from permits it reads itself — never
// from the loaded page — so a permit approved onto the certificate after the
// consents were gathered still blocks the trial.
function trialReadyToEnergise(iso, permits) {
  const t = iso && iso.trialRun;
  if (!t || t.status !== "approved") return false;
  if (!t.issuerApproval) return false;
  // No id means the crew list could not be resolved, and an empty crew list
  // would then read as "nobody is working here". Silence from a failed lookup
  // is not consent.
  if (!iso.id) return false;
  // Locks must still be on and staying on: an assigned, removalPending or
  // removed certificate is not a lockout anyone may lift for a trial.
  if (iso.status !== "active") return false;
  const c = trialConsentState(iso, permits);
  return c.refused.length === 0 && c.outstanding.length === 0;
}

// Pass `known` when the caller already holds the permit list (the dashboard
// does) — the badge is only a count of submitted permits, and downloading the
// whole collection a second time to derive it is pure waste.
async function refreshPendingBadge(known) {
  if (!["issuer", "admin"].includes(State.profile.role)) return;
  try {
    const permits = known || await fetchPermits();
    // Matches the dashboard tile: auto-rejected permits are not owed work. No
    // certificates are fetched because none are needed — a `submitted` permit
    // has no isolationRef yet (one is minted at approval), so autoRejectSafe()
    // resolves without them.
    const pol = autoRejectPolicy();
    const pending = permits.filter((p) => p.status === "submitted" && !isAutoRejected(p, [], pol)).length;
    const b = $('.navitem[data-v="dashboard"] [data-badge]');
    if (b) { b.classList.toggle("hidden", pending === 0); b.textContent = pending; }
  } catch {}
}

/* -------------------- Queue attention --------------------
   The KPI row is five identical white cards, so the two tiles that mean "you
   have work" read no differently from the three that are background numbers.
   These helpers give the actionable two a state: calm while the queue is
   empty, amber once something is waiting, red once the oldest item has waited
   longer than QUEUE_ALERT_HRS.

   Age, not count, is what deserves the escalation. "3 awaiting closure" does
   not say whether that is three from ten minutes ago or one that has held a
   machine locked out since yesterday — and the second is the safety problem,
   because equipment awaiting closure is blocked for new work (equipmentBlock).

   One threshold rather than a ladder of shades: the question is "is anything
   sitting too long?", and intermediate colours only blur the answer. The calm
   state matters as much as the loud one — a tile that is permanently amber
   stops being read within a week, and then the real backlog goes unnoticed. */
const QUEUE_ALERT_HRS = 8;
// How many rows the dashboard's permit card shows. A cap keeps the card to
// roughly one screen so the tiles and the two task tables above it stay
// reachable — on a phone an uncapped list would bury them under a long scroll.
// The rows that fall off are the least urgent (see byAttention), and the card
// always says how many it is not showing.
const DASH_ROWS = 12;

// Compact age for the tile sub-line: "40 min", "6 h", "2 d".
function ageText(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (m < 60) return m <= 1 ? "just now" : m + " min";
  const h = Math.floor(m / 60);
  return h < 24 ? h + " h" : Math.floor(h / 24) + " d";
}
const laterOf = (a, b) => {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (isNaN(ta)) return b;
  if (isNaN(tb)) return a;
  return tb > ta ? b : a;
};
// `since` maps an item to the moment it started waiting on THIS person — never
// simply createdAt, because a permit raised last week but approved an hour ago
// has not been awaiting closure for a week. See each caller for its own rule.
// `alertHrs` is how long is too long for THIS queue, and it is not one number
// for the whole app. Eight hours is right where people are blocked waiting on
// a signature — an unapproved permit means a crew standing around. It is
// nonsense for a Requester's queue, where the wait is a job that runs for days:
// at eight hours the tile would be red above rows that are still plain. That
// tile passes the row threshold instead, so tile and rows always agree.
function queueState(items, since, alertHrs = QUEUE_ALERT_HRS) {
  if (!items.length) return { tone: "calm" };
  const times = items.map((i) => Date.parse(since(i))).filter((t) => !isNaN(t));
  if (!times.length) return { tone: "warn" };       // waiting, but undatable
  const oldest = Math.min(...times);
  return {
    tone: Date.now() - oldest >= alertHrs * 3600000 ? "alert" : "warn",
    oldest: new Date(oldest).toISOString()
  };
}

// Order for the dashboard's "Active work" card. Two rules, both of them
// consequences of most permits on this site being open-ended:
//
//   1. Work still in progress leads. A permit whose crew has already signed
//      off is not forgotten — it is waiting on the Issuer or the Isolator, and
//      it has its own card for that. It stays on this one, because the
//      equipment is still isolated, but it does not take the top.
//   2. Within a group, longest-live first. An open-ended permit has no planned
//      end to be late against, so isOverdue is structurally false for it and
//      elapsed time is the only signal that a job has been forgotten.
//
// Deadlines deliberately play no part: the dashboard's red overdue banner sits
// directly above these cards and already carries that, so repeating it here
// would only crowd out the permits nothing else reports on.
function byWorkAge(isolations) {
  const rank = (p) => (permitStage(p, isolations) === "inProgress" ? 0 : 1);
  return (a, b) => rank(a) - rank(b) ||
    (Date.parse(permitLiveSince(a)) || Infinity) - (Date.parse(permitLiveSince(b)) || Infinity);
}

/* -------------------- 5a. Dashboard -------------------- */
async function viewDashboard(m) {
  m.innerHTML = `<div class="page-head"><div><div class="kick">Overview</div><h2>Welcome, ${esc(State.profile.name.split(" ")[0])}</h2></div>
    <div class="actions"><button class="btn btn-accent">+ New Permit</button></div></div>
    <div id="dash">Loading…</div>`;
  m.querySelector(".actions .btn").onclick = () => go("new");
  const token = LiveView.token;
  // Everything below rebuilds only #dash, so a live refresh replaces the
  // content without the surrounding page flashing back to "Loading…".
  const paint = async () => {
  // The three collections are independent, so fetch them concurrently — run
  // sequentially this was three full round trips back to back before the page
  // could render anything.
  const [permits, equip, isoAll] = await Promise.all([fetchPermits(), fetchEquipment(), fetchIsolations()]);
  refreshPendingBadge(permits);   // reuse what we just loaded — no second fetch
  const mine = permits.filter((p) => p.requester?.uid === State.profile.id);
  const active = permits.filter((p) => ["active", "extended"].includes(p.status));
  const isoMap = isoIndex(isoAll);
  // Auto-rejected permits leave the approval queue — that is the whole point of
  // the feature: a permit nobody decided on within the allowed time is no longer
  // work anybody owes. They stay findable under the register's "auto-rejected"
  // filter. A permit whose auto-rejection is HELD (its lockout needs a person)
  // deliberately stays in the queue, and carries a chip saying so.
  const arPol = autoRejectPolicy();
  const pending = permits.filter((p) => p.status === "submitted" && !isAutoRejected(p, isoMap, arPol));
  // Energised-for-trial equipment used to be counted inside "Equipment
  // isolated", which made a live machine indistinguishable from a locked-out
  // one on the only screen everybody looks at. They are opposite states.
  const isolated = equip.filter((e) => e.isolationStatus === "isolated");
  const energisedEq = equip.filter((e) => e.isolationStatus === "trialRun");
  const isIssuer = ["issuer", "admin"].includes(State.profile.role);
  const overdue = (isIssuer ? permits : mine).filter(isOverdue);
  // The other half of the Issuer's queue. A permit whose crew has signed off
  // and whose lockout (if any) is already removed needs nothing but closure —
  // but the permit sits in "active" until then, so it used to be reachable
  // only by searching the register. Surfaced here exactly like approvals.
  const awaitingClosure = isIssuer ? active.filter((p) => permitStage(p, isoMap) === "awaitingClosure") : [];

  const me = State.profile.id;
  const isAdmin = State.profile.role === "admin";
  // Any Isolator sees all open isolation / de-isolation tasks (not just ones
  // assigned to them by name) so whoever is on shift can action them. A cert
  // becomes a de-isolation task automatically once all its crews report done.
  // De-isolation is a physical lockout job, so it is an Isolator task only —
  // the Issuer does NOT de-isolate (Admin is kept as a system superuser).
  const isIso = State.profile.role === "isolator";
  // Readiness is needed three times below (the de-isolation tile, picking the
  // tasks, then labelling each row). Work it out once per certificate against
  // a single grouped index rather than re-scanning every permit each time.
  const byIso = permitsByIso(permits);
  const readyForDeiso = new Set(isoAll.filter((i) => isoReadyForDeiso(i, permits, byIso)).map((i) => i.id));
  // The Isolator's two queues, counted exactly as the task table below picks
  // its rows: locks to apply, then locks to remove — where "to remove" covers
  // both an explicit removalPending and a certificate whose crews have all
  // signed off (the far more common route, and one with no stored status).
  const pendingIso = isIso ? isoAll.filter((i) => i.status === "assigned") : [];
  const pendingDeiso = isIso ? isoAll.filter((i) => i.status === "removalPending" || readyForDeiso.has(i.id)) : [];
  // When the last crew on a certificate signed off — i.e. when its locks
  // became removable. Stored timestamps are UTC ISO, so they sort as text.
  const lastSignOff = (ps) => (ps || []).map((p) => p.workCompletion?.timestamp).filter(Boolean).sort().pop();

  // Each tile is a shortcut into a pre-filtered list. `nav` = {view, params};
  // omit it (as the empty banner does) to render a plain, non-clickable tile.
  // `q` is a queueState(): pass it only for a tile the viewer can act on —
  // that is what earns the colour, the age line and the urgent wording, and
  // withholding it everywhere else is what keeps the colour meaningful.
  const stat = (num, lab, ic, nav, q) => {
    // Colour is never the only signal: the sub-line says the same thing in
    // words for anyone who cannot rely on it, and so does the aria-label.
    const age = q && q.oldest ? ageText(q.oldest) : "";
    const sub = !q ? ""
      : q.tone === "calm" ? `<div class="sub">Nothing waiting</div>`
      : `<div class="sub">${age ? `oldest ${esc(age)}` : "waiting"}${q.tone === "alert" ? " · needs attention" : ""}</div>`;
    const say = !q ? "" : q.tone === "calm" ? ", nothing waiting"
      : q.tone === "alert" ? `, oldest waiting ${age} — needs attention` : `, oldest waiting ${age}`;
    const cls = `stat${nav ? " stat-link" : ""}${q ? " stat-q stat-" + q.tone : ""}`;
    return `<div class="${cls}"${nav ? ` role="button" tabindex="0" data-nav='${esc(JSON.stringify(nav))}' aria-label="${esc(lab)}: ${num}${esc(say)}. View list"` : ""}><div class="ic">${ic}</div><div class="num">${num}</div><div class="lab">${lab}</div>${sub}</div>`;
  };
  // What is waiting for me, in the terms of the role holding the screen: an
  // Issuer approves then closes, an Isolator applies locks then removes them.
  //
  // These lead the row. The eye lands top-left first, and that position used
  // to hold "Active permits" — a number nobody acts on — which left the only
  // two tiles anyone has to act on sitting mid-row, styled identically to the
  // background counts either side of them.
  //
  // A Requester has one too, and it is the easiest of the three to overlook:
  // a draft they never submitted, and — the one that costs — a finished job
  // they never confirmed complete, which leaves the equipment isolated with
  // nobody waiting on anybody. "My submitted" is NOT that queue: it is waiting
  // on the Issuer, so it stays a plain informational tile.
  const needsMe = isIssuer || isIso ? [] : mine.filter(awaitsRequester);
  const queueTiles = isIssuer
    // A permit sitting in "submitted" is not written to again until someone
    // approves or rejects it, so updatedAt is the moment it was submitted.
    ? stat(pending.length, "Awaiting your approval", ICON.newdoc, { view: "permits", params: { status: "submitted" } },
        queueState(pending, (p) => p.updatedAt || p.createdAt)) +
      // Closable from the later of the two sign-offs it waits on: the crew
      // confirming the work is finished, and the locks actually coming off.
      stat(awaitingClosure.length, "Awaiting your closure", ICON.doccheck, { view: "permits", params: { status: "stage:awaitingClosure" } },
        queueState(awaitingClosure, (p) => laterOf(p.workCompletion?.timestamp, p.isolationRef ? isoMap.get(p.isolationRef)?.removedAt : null)))
    : isIso
    ? stat(pendingIso.length, "Pending isolation", ICON.lockplus, { view: "isolations", params: { status: "assigned" } },
        queueState(pendingIso, (i) => i.assignedAt || i.createdAt)) +
      // Two ways into this queue, so two clocks: an explicit hand-back
      // assignment, or — the common route — the last crew signing off, which
      // is the moment the locks became removable.
      stat(pendingDeiso.length, "Pending de-isolation", ICON.unlock, { view: "isolations", params: { status: "pendingDeiso" } },
        queueState(pendingDeiso, (i) => i.status === "removalPending"
          ? (i.removalAssignedAt || i.updatedAt || i.createdAt)
          : lastSignOff(byIso.get(i.id))))
    : stat(needsMe.length, "Needs your action", ICON.doccheck, { view: "permits", params: { status: "awaitingRequester", mine: true } },
        queueState(needsMe, requesterWaitSince, PERMIT_STALE_DAYS * 24)) +
      stat(mine.filter((p) => p.status === "submitted").length, "My submitted", ICON.newdoc, { view: "permits", params: { status: "submitted", mine: true } });
  // Five tiles for every role that has a queue — the row is auto-fit (see
  // .stat-grid) so the extra tile stays on the same line.
  let html = `<div class="cols stat-grid" style="margin-bottom:1.2rem">
    ${queueTiles}
    ${stat(active.length, "Active permits", ICON.list, { view: "permits", params: { status: "activeAll" } })}
    ${stat(isolated.length, "Equipment isolated", ICON.lock, { view: "equipment", params: { status: "isolated" } })}
    ${energisedEq.length ? stat(energisedEq.length, "Energised for trial", ICON.unlock, { view: "equipment", params: { status: "trialRun" } },
        queueState(trialTasks(isoAll, permits).filter((t) => t.kind === "reIsolate"), (t) => t.since, TRIAL_LIVE_ALERT_HRS)) : ""}
    ${stat(mine.length, "My permits", ICON.cube, { view: "permits", params: { mine: true } })}</div>`;

  // A live trial is the loudest thing this app can be looking at, so it goes
  // above the overdue banner and is shown to every role, not only the one that
  // has to act. Someone who knows the plant may be the one to notice.
  const trialAll = trialTasks(isoAll, permits);
  const trialLive = trialAll.filter((t) => t.kind === "reIsolate");
  if (trialLive.length) {
    const oldest = queueState(trialLive, (t) => t.since, TRIAL_LIVE_ALERT_HRS);
    html += `<div class="danger-box" id="trialBanner" style="cursor:pointer">
      <b>⚠ ${trialLive.length} item(s) of equipment ENERGISED for a trial run</b> — ${esc(trialLive.map((t) => t.iso.equipmentTag || t.iso.isoNo || t.iso.id).join(", "))}.
      ${oldest.oldest ? `Live for ${ageText(oldest.oldest)}. ` : ""}${(() => {
        const over = trialLive.map((t) => trialOverrun(t.iso)).filter((o) => o && o.over && o.stated);
        return over.length ? `<b>${over.length} past the ${over[0].expected} min the crew asked for.</b> ` : "";
      })()}${trialLive.some((t) => t.done) ? "The crew has confirmed the trial is finished. " : ""}An Isolator must re-isolate before work resumes.</div>`;
  }
  // The crews' own half: their permit page shows this too, but only if they
  // open it, and a trial run waits on every crew at once.
  const myConsent = trialAll.filter((t) => t.kind === "consent" &&
    trialConsentState(t.iso, permits.filter((p) => p.isolationRef === t.iso.id)).outstanding
      .some((p) => p.requester?.uid === me));
  if (myConsent.length) html += `<div class="warn-box" id="trialConsentBanner" style="cursor:pointer">
    <b>${myConsent.length} trial run(s) are waiting on your crew to clear.</b> Open the permit and confirm your people are clear of the equipment, or refuse.</div>`;

  if (overdue.length) html += `<div class="danger-box" id="overdueBanner" style="cursor:pointer"><b>${overdue.length} permit(s) overdue</b> — the planned end has passed. Review and extend or close them.</div>`;

  const tasks = isoAll.filter((i) =>
    (i.status === "assigned" && (isIssuer || isIso || i.assignedTo?.uid === me)) ||
    (i.status === "removalPending" && (isIso || isAdmin || i.removalAssignedTo?.uid === me)) ||
    (readyForDeiso.has(i.id) && (isIso || isAdmin)));
  if (tasks.length) {
    html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Isolation tasks</h3></div>
      <table class="tbl"><thead><tr><th>Certificate</th><th>Equipment</th><th>Status</th><th>Assigned to</th></tr></thead><tbody>
      ${tasks.map((i) => { const deiso = i.status === "removalPending" || readyForDeiso.has(i.id); return `<tr class="row" data-iid="${i.id}">
        <td><span class="mono">${esc(i.isoNo || i.id)}</span></td><td>${esc(i.equipmentTag)}</td>
        <td>${badge(deiso ? "removalPending" : i.status)}</td><td>${esc((deiso ? i.removalAssignedTo?.name : i.assignedTo?.name) || "—")}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  }

  const myTrials = trialTasksFor(trialAll, State.profile.role);
  if (myTrials.length) {
    html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Trial runs</h3></div>
      <table class="tbl"><thead><tr><th>Certificate</th><th>Equipment</th><th>Stage</th><th>Waiting on</th><th>For</th></tr></thead><tbody>
      ${myTrials.map((t) => { const d = TRIAL_TASK[t.kind]; return `<tr class="row" data-tiid="${t.iso.id}">
        <td><span class="mono">${esc(t.iso.isoNo || t.iso.id)}</span></td><td>${esc(t.iso.equipmentTag || "—")}</td>
        <td><span class="badge-st ${t.kind === "reIsolate" ? "stage-trialRun" : "stage-trialPending"}">${esc(d.label)}</span>${t.done ? ` <span class="chip chip-ok">✔ crew finished</span>` : ""}</td>
        <td>${esc(d.who)}${t.outstanding ? ` (${t.outstanding})` : ""}</td>
        <td>${esc(ageText(t.since) || "—")}${(() => { const o = trialOverrun(t.iso); return o && o.over && o.stated
          ? ` <span class="chip" style="background:var(--red-soft);color:#9b2c2c">over ${o.expected} min</span>` : ""; })()}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  }

  if (isIssuer && pending.length) {
    html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Awaiting approval</h3></div>
      <table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Requester</th><th></th></tr></thead><tbody>
      ${pending.map((p) => permitRow(p)).join("")}</tbody></table></div>`;
  }
  if (awaitingClosure.length) {
    // Work-complete time is the useful column here (how long the permit has
    // been sitting on the Issuer's desk); an overdue one is the most urgent.
    html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Awaiting closure</h3></div>
      <table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Work complete</th><th>Requester</th></tr></thead><tbody>
      ${awaitingClosure.map((p) => `<tr class="row" data-pid="${p.id}">
        <td><span class="mono">${esc(p.permitNo)}</span>${isOverdue(p) ? " " + overdueChip() : ""}</td>
        <td><span class="type-pill"><span class="dot" style="background:${TYPE_DOT[p.type]}"></span>${esc(p.typeName || p.type)}</span></td>
        <td>${esc(p.equipmentTag || "—")}</td>
        <td>${fmt(p.workCompletion?.timestamp)}</td>
        <td>${esc(p.requester?.name || "—")}</td></tr>`).join("")}
      </tbody></table></div>`;
  }
  // A Requester's card spans every status they hold, draft to closed. It used
  // to be titled "recent" and left in fetch order, which is newest first —
  // precisely the order that hides a forgotten permit, and with the 12-row cap
  // hides it completely. It is now ordered by what is waiting on them.
  // Copy before sorting; `active` and `mine` are both used above.
  const listed = isIssuer ? [...active].sort(byWorkAge(isoMap)) : [...mine].sort(byOwnAttention);
  const shown = listed.slice(0, DASH_ROWS);
  const moreNav = isIssuer ? { view: "permits", params: { status: "activeAll" } } : { view: "permits", params: { mine: true } };
  html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>${isIssuer ? "Active work" : "My permits"}</h3></div>
    <table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Status</th><th>Requester</th><th>${isIssuer ? "Live for" : "Waiting"}</th></tr></thead><tbody>
    ${shown.map((p) => permitRow(p, true, isoMap, !isIssuer)).join("") || `<tr><td colspan="6" class="empty">Nothing yet — raise a permit to get started.</td></tr>`}
    ${listed.length > shown.length ? `<tr class="row more-row" role="button" tabindex="0" data-nav='${esc(JSON.stringify(moreNav))}'><td colspan="6">Showing ${shown.length} of ${listed.length} · View all</td></tr>` : ""}
    </tbody></table></div>`;
  const host = $("#dash");
  if (!host) return;            // navigated away while the data was loading
  host.innerHTML = html;
  bindPermitRows();
  // Anything carrying a nav drills through to its pre-filtered list — the KPI
  // tiles and the "showing N of M" footer alike; keyboard-activatable too.
  $$("[data-nav]").forEach((t) => {
    const nav = () => { const n = JSON.parse(t.dataset.nav); go(n.view, n.params); };
    t.onclick = nav;
    t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nav(); } };
  });
  const ob = $("#overdueBanner"); if (ob) ob.onclick = () => go("permits", { status: "overdue" });
  const tb = $("#trialBanner"); if (tb) tb.onclick = () => go("equipment", { status: "trialRun" });
  const cb = $("#trialConsentBanner"); if (cb) cb.onclick = () => go("permits", { mine: true, status: "activeAll" });
  $$("tr.row[data-tiid]").forEach((r) => r.onclick = () => go("isodetail", { id: r.dataset.tiid }));
  $$("tr.row[data-iid]").forEach((r) => r.onclick = () => go("isodetail", { id: r.dataset.iid }));
  };
  await paint();
  LiveView.bind(token, paint);
}

// Two shapes, one per dashboard card. The approval queue wants neither status
// (every row is "submitted") nor an age (nothing has started yet); the live
// card wants the derived hand-back stage and how long the permit has been on
// site — without that column the card is sorted by something it never shows.
// The age cell. On the site card it is how long the permit has been live; on
// the Requester's card, how long the thing waiting on them has been waiting —
// which for an unsubmitted draft is not a "live" age at all. A row nobody is
// waiting on (submitted, closed, rejected) shows nothing rather than a number
// that would invite the wrong reading.
function rowAge(p, mine, live) {
  if (mine && awaitsRequester(p)) return ageText(requesterWaitSince(p));
  return live ? ageText(permitLiveSince(p)) : "—";
}
// `mine` marks the Requester's own card, where a row means something different:
// what is waiting on THEM, not on the site. The two cards ask different
// questions of the same permit, so they colour different rows.
function permitRow(p, liveWork = false, isolations = [], mine = false) {
  const stage = liveWork ? permitStage(p, isolations) : null;
  // A Requester's card mixes in drafts and closed permits, where "live for"
  // is meaningless — only a permit that is actually live has been live.
  const live = ["active", "extended"].includes(p.status);
  // The row itself carries staleness — no chip. On the site card only work
  // still in progress can be stale: one already in hand-back is waiting on a
  // named person and is reported on its own card, so colouring it here would
  // blame the wrong queue. On the Requester's card the same reasoning picks a
  // different set — only what is genuinely theirs to move.
  const stale = !liveWork ? 0
    : mine ? (awaitsRequester(p) ? staleLevel(requesterWaitSince(p)) : 0)
    : (live && stage === "inProgress" ? staleLevel(permitLiveSince(p)) : 0);
  return `<tr class="row${stale ? " stale-" + stale : ""}" data-pid="${p.id}">
    <td><span class="mono">${esc(p.permitNo)}</span></td>
    <td><span class="type-pill"><span class="dot" style="background:${TYPE_DOT[p.type]}"></span>${esc(p.typeName || p.type)}</span></td>
    <td>${esc(p.equipmentTag || "—")}</td>
    ${liveWork ? `<td>${badge(p.status)}${stageChip(stage)}${isOverdue(p) ? " " + overdueChip() : ""}</td>` : ""}
    <td>${esc(p.requester?.name || "—")}</td>
    ${liveWork ? `<td>${esc(rowAge(p, mine, live))}</td>` : `<td></td>`}
  </tr>`;
}
function bindPermitRows() { $$("tr.row[data-pid]").forEach((r) => r.onclick = () => go("detail", { id: r.dataset.pid })); }

/* -------------------- 5b. Permit Register -------------------- */
async function viewPermits(m) {
  let lastRows = [], isos = [];
  m.innerHTML = `<div class="page-head"><div><div class="kick">Records</div><h2>Permit Register</h2></div>
    <div class="actions"><button class="btn btn-ghost" id="expCsv">Export CSV</button><button class="btn btn-accent" id="np">+ New Permit</button></div></div>
    ${tabsHtml("p")}
    <div class="filters">
      <input class="search" id="q" placeholder="Search permit no, equipment, work…">
      <select id="fType"><option value="">All types</option></select>
      <select id="fStatus"><option value="">All statuses</option>
        <option value="activeAll">active / extended</option>
        <option value="stage:inProgress">work in progress</option>
        <option value="stage:awaitingDeisolation">awaiting de-isolation</option>
        <option value="stage:awaitingClosure">awaiting closure</option>
        <option value="awaitingRequester">awaiting requester</option>
        ${["draft", "submitted", "awaitingIsolation", "active", "extended", "closed", "rejected"].map((s) => `<option>${s}</option>`).join("")}
        <option value="overdue">overdue</option>
        <option value="autoRejected">auto-rejected</option></select>
      <select id="fDept"><option value="">All departments</option></select>
      <label class="mine-toggle"><input type="checkbox" id="fMine"> My permits</label>
    </div>
    <div class="card pad0" id="ptable">Loading…</div>`;
  $("#np").onclick = () => go("new");
  $("#expCsv").onclick = () => exportPermitsCsv(lastRows, isos);
  bindTabs();
  $("#fType").innerHTML += State.config.permitTypes.map((t) => `<option value="${t.code}">${esc(t.name)}</option>`).join("");
  $("#fDept").innerHTML += State.config.departments.map((d) => `<option>${esc(d.name)}</option>`).join("");
  if (State.params.status) $("#fStatus").value = State.params.status;
  if (State.params.mine) $("#fMine").checked = true;
  // Certificates are needed to derive each live permit's hand-back stage
  // (work in progress → awaiting de-isolation → awaiting closure), and are
  // independent of the permits themselves — so fetch both concurrently.
  const token = LiveView.token;
  let [all, isosLoaded] = await Promise.all([fetchPermits(), fetchIsolations().catch(() => [])]);
  isos = isosLoaded;
  // Index the certificates once for the whole view — draw() runs on every
  // filter change and keystroke, and derives a stage for each row.
  let isoMap = isoIndex(isos);
  const arPol = autoRejectPolicy();
  const draw = () => {
    const q = $("#q").value.toLowerCase(), ft = $("#fType").value, fs = $("#fStatus").value, fd = $("#fDept").value, fm = $("#fMine").checked;
    const rows = all.filter((p) =>
      (!ft || p.type === ft) &&
      (!fs || (fs === "overdue" ? isOverdue(p)
        // Both halves of auto-rejection: the ones already stamped `expired` and
        // the ones only derived so far. Without this an Issuer would have no way
        // to find a permit that had quietly left their approval queue.
        : fs === "autoRejected" ? (p.status === "expired" || isAutoRejected(p, isoMap, arPol))
        // Not a stage: it spans a draft (never submitted) and a live permit
        // whose crew has not signed off, which is a status the stages do not
        // reach. Useful to an Issuer too — it answers "who has not signed off?"
        : fs === "awaitingRequester" ? awaitsRequester(p)
        : fs.startsWith("stage:") ? permitStage(p, isoMap) === fs.slice(6)
        : fs === "activeAll" ? ["active", "extended"].includes(p.status) : p.status === fs)) &&
      (!fd || p.requestingDepartment?.department === fd) &&
      (!fm || p.requester?.uid === State.profile.id) &&
      (!q || [p.permitNo, p.equipmentTag, p.workDescription, p.requester?.name].join(" ").toLowerCase().includes(q)));
    lastRows = rows;
    $("#ptable").innerHTML = `<table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Dept</th><th>Status</th><th>Requester</th><th>Created</th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="row" data-pid="${p.id}">
        <td><span class="mono">${esc(p.permitNo)}</span></td>
        <td><span class="type-pill"><span class="dot" style="background:${TYPE_DOT[p.type]}"></span>${esc(p.typeName)}</span></td>
        <td>${esc(p.equipmentTag)}</td><td>${esc(p.requestingDepartment?.department || "—")}</td>
        <td>${badge(p.status)}${stageChip(permitStage(p, isoMap))}${isOverdue(p) ? " " + overdueChip() : ""}${autoRejectChip(autoRejectState(p, isoMap, arPol))}</td><td>${esc(p.requester?.name)}</td><td>${fmtDate(p.createdAt)}</td></tr>`).join("")
      || `<tr><td colspan="7" class="empty">No permits match.</td></tr>`}</tbody></table>`;
    bindPermitRows();
  };
  $("#q").addEventListener("input", debounce(draw));
  ["fType", "fStatus", "fDept"].forEach((id) => $("#" + id).addEventListener("input", draw));
  $("#fMine").addEventListener("change", draw);
  draw();
  // draw() rewrites only #ptable, so a live refresh leaves the search box and
  // the filter selections exactly as the user left them.
  LiveView.bind(token, async () => {
    [all, isos] = await Promise.all([fetchPermits(), fetchIsolations().catch(() => [])]);
    isoMap = isoIndex(isos);
    if ($("#ptable")) draw();
  });
}

// Download the currently-filtered permit register as a CSV file (client-side).
function exportPermitsCsv(rows, isolations = []) {
  if (!rows || !rows.length) return toast("Nothing to export for the current filter", "err");
  const cols = [
    ["Permit No", (p) => p.permitNo],
    ["Type", (p) => p.typeName || p.type],
    ["Status", (p) => {
      const stage = permitStage(p, isolations);
      let s = p.status + (stage ? ` (${STAGE_LABEL[stage].toLowerCase()})` : "");
      if (isOverdue(p)) s += " (overdue)";
      const ar = autoRejectState(p, isolations, autoRejectPolicy());
      if (ar?.phase === "lapsed") s += " (auto-rejected)";
      if (ar?.phase === "held") s += " (auto-reject held)";
      return s;
    }],
    ["Equipment", (p) => p.equipmentTag],
    ["Line", (p) => p.line], ["Area", (p) => p.area],
    ["Department", (p) => p.requestingDepartment?.department || ""],
    ["Requester", (p) => p.requester?.name || ""],
    ["Work", (p) => p.workDescription || ""],
    ["Valid from", (p) => p.validity?.start || ""],
    ["Valid to", (p) => p.validity?.openEnded ? "Open" : (p.validity?.extendedTo || p.validity?.plannedEnd || "")],
    ["Isolation cert", (p) => p.isoNo || ""],
    ["Created", (p) => p.createdAt || ""]
  ];
  downloadCsv(cols, rows, `permits-${nowISO().slice(0, 10)}.csv`);
  toast(`Exported ${rows.length} permit(s)`, "ok");
}

// Build a CSV from [header, valueFn] column pairs and save it client-side. The
// leading BOM keeps Excel from mangling non-ASCII tags/descriptions.
function downloadCsv(cols, rows, filename) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => cell(c[0])).join(",")]
    .concat(rows.map((r) => cols.map((c) => cell(c[1](r))).join(",")))
    .join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

/* -------------------- 5c. New Permit -------------------- */
async function viewNewPermit(m) {
  if (!State.profile.active) { m.innerHTML = `<div class="danger-box">Your account is not active yet.</div>`; return; }
  const cfg = State.config;
  const equip = await fetchEquipment();
  // Editing an existing draft? Load it (owner-only, drafts only) and prefill the
  // form below. Anything else falls through to a blank "new permit".
  const editId = State.params.editId || null;
  let editing = null;
  if (editId) {
    const s = await getDoc(doc(db, "permits", editId)).catch(() => null);
    if (!s || !s.exists()) return go("permits");
    editing = { id: editId, ...s.data() };
    if (editing.status !== "draft" || editing.requester?.uid !== State.profile.id) return go("detail", { id: editId });
  }
  // Cloning: an auto-rejected permit is finished and cannot be revived, so the
  // way back is a NEW one. Copying the description, equipment, checklist and PPE
  // across removes the only real cost of that — nobody should have to retype a
  // permit because a deadline passed. Dates and gas readings are deliberately
  // NOT copied: they are the two things that were stale, and the requester must
  // enter them afresh.
  const cloneId = !editId && State.params.cloneId || null;
  let cloning = null;
  if (cloneId) {
    const s = await getDoc(doc(db, "permits", cloneId)).catch(() => null);
    if (!s || !s.exists()) return go("permits");
    cloning = { id: cloneId, ...s.data() };
    // Confined Space Entry is Admin-only to raise (see visibleTypes below) —
    // the clone shortcut must not be a back door around that.
    if (cloning.type === "confined" && !isAdmin()) {
      toast("Only an Admin can raise a new Confined Space Entry permit.", "err");
      return go("detail", { id: cloneId });
    }
  }
  // What the form is filled from — the draft being edited, or the permit being
  // copied. `editing` stays null when cloning, so the save path creates a new
  // permit with a new number rather than writing over the old one.
  const source = editing || cloning;
  // Confined Space Entry is restricted to Admins in the picker below — this is
  // a UI convenience only, not a security boundary (see firestore.rules for
  // what is actually enforced).
  const visibleTypes = cfg.permitTypes.filter((t) => t.code !== "confined" || isAdmin());
  let type = source ? (cfg.permitTypes.find((t) => t.code === source.type) || visibleTypes[0]) : visibleTypes[0];
  let prefilled = false;
  const draw = () => {
    const deptOpts = cfg.departments.map((d) => `<option>${esc(d.name)}</option>`).join("");
    m.innerHTML = `<div class="page-head"><div><div class="kick">${editing ? "Edit" : "Create"}</div><h2>${editing ? "Edit Draft Permit" : "New Work Permit"}</h2></div></div>
    ${cloning ? `<div class="info-box">Copied from <span class="mono">${esc(cloning.permitNo || "")}</span>${cloning.status === "expired" ? ", which was auto-rejected" : ""}. <b>Check the dates${type.requiresGasTest ? " and take a fresh gas test" : ""}</b> — they are not carried over. This will be raised as a new permit with its own number.</div>` : ""}
    <div class="card ${TYPE_CLASS[type.code]}">
      <h3>Permit type</h3><div class="csub">Choose the kind of work — the form adapts to it.</div>
      <div class="cols cols-4">${visibleTypes.map((t) => `
        <button class="navitem ${t.code === type.code ? "active" : ""}" data-type="${t.code}" style="border:1px solid var(--line);justify-content:center;text-align:center">
          <span class="dot" style="background:${TYPE_DOT[t.code]}"></span>${esc(t.name)}</button>`).join("")}</div>
    </div>

    <div class="card">
      <h3>Equipment</h3><div class="csub">Search by tag or name. ${type.requiresIsolation ? "This permit requires isolation." : ""}</div>
      <label class="field"><span>Equipment <span class="req">*</span></span>
        <input type="text" id="eqSearch" placeholder="Type tag e.g. 362FN1 or a name…" autocomplete="off">
        <div id="eqResults"></div>
        <input type="hidden" id="eqId"><div id="eqChosen"></div>
      </label>
      <div id="simops"></div>
    </div>

    <div class="card">
      <h3>Work details</h3>
      <div class="grid-2">
        <label class="field"><span>Requesting department <span class="req">*</span></span>
          <select id="dept">${deptOpts}</select></label>
        <label class="field"><span>Sub-unit</span><select id="subunit"></select></label>
      </div>
      <label class="field"><span>Work description <span class="req">*</span></span>
        <textarea id="desc" placeholder="Describe the work to be carried out…"></textarea></label>
      <label class="field"><span>Specific location / note</span><input type="text" id="loc" placeholder="e.g. motor NDE bearing"></label>
      <div class="grid-2">
        <label class="field"><span>Valid from <span class="req">*</span></span><input type="datetime-local" id="vstart"></label>
        <label class="field"><span>Planned end</span><input type="datetime-local" id="vend">
          <span class="help"><label class="checkline" style="padding:.3rem 0"><input type="checkbox" id="vopen"> Open-ended (valid while active)</label></span></label>
      </div>
    </div>

    <div class="card">
      <h3>Hazard checklist — ${esc(type.name)}</h3>
      <div id="checks">${type.checklist.map((c, i) => `<label class="checkline"><input type="checkbox" data-chk="${i}"> ${esc(c)}</label>`).join("")}</div>
    </div>

    <div class="card">
      <h3>PPE required</h3>
      <div class="cols cols-3">${cfg.ppeList.map((p) => `<label class="checkline"><input type="checkbox" data-ppe value="${esc(p)}"> ${esc(p)}</label>`).join("")}</div>
    </div>

    ${type.requiresIsolation ? `<div class="card">
      <h3>Isolation / LOTO register</h3><div class="csub">List the isolation points to be applied.</div>
      <div id="isoRows"></div>
      <button class="btn btn-ghost btn-sm" id="addIso">+ Add isolation point</button></div>` : ""}

    ${type.requiresGasTest ? `<div class="card">
      <h3>Gas test</h3><div class="csub">Record readings where applicable.</div>
      <div class="grid-3">
        <label class="field"><span>O₂ (%)</span><input type="number" step="0.1" id="g_o2" placeholder="20.9"></label>
        <label class="field"><span>LEL (%)</span><input type="number" step="0.1" id="g_lel" placeholder="0"></label>
        <label class="field"><span>H₂S (ppm)</span><input type="number" step="1" id="g_h2s" placeholder="0"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>CO (ppm)</span><input type="number" step="1" id="g_co" placeholder="0"></label>
        <label class="field"><span>Tested by</span><input type="text" id="g_by" placeholder="Name"></label>
      </div></div>` : ""}

    <div class="card" style="display:flex;gap:.7rem;justify-content:flex-end">
      <button class="btn btn-ghost" id="saveDraft">Save as draft</button>
      <button class="btn btn-accent" id="submit">Submit for approval</button>
    </div>`;

    // type buttons
    $$("[data-type]").forEach((b) => b.onclick = () => { type = cfg.permitTypes.find((t) => t.code === b.dataset.type); draw(); });
    // default validity start = now
    const n = new Date(); n.setMinutes(n.getMinutes() - n.getTimezoneOffset());
    $("#vstart").value = n.toISOString().slice(0, 16);
    // Open-ended permits have no planned end — disable the end field accordingly.
    const vopenEl = $("#vopen"), vendEl = $("#vend");
    const syncOpen = () => { vendEl.disabled = vopenEl.checked; if (vopenEl.checked) vendEl.value = ""; };
    vopenEl.onchange = syncOpen; syncOpen();
    // dept → subunit
    const fillSub = () => { const d = cfg.departments.find((x) => x.name === $("#dept").value);
      $("#subunit").innerHTML = `<option value="">—</option>` + (d?.subUnits || []).map((s) => `<option>${esc(s)}</option>`).join(""); };
    $("#dept").onchange = fillSub; fillSub();
    // equipment search
    const eqSearch = $("#eqSearch"), eqResults = $("#eqResults");
    eqSearch.addEventListener("input", debounce(() => {
      const q = eqSearch.value.toLowerCase().trim();
      if (!q) { eqResults.innerHTML = ""; return; }
      // Tag-first ranking: exact tag > tag starts-with > tag contains >
      // description contains. Every match is shown (no cap) in a scrollable
      // list, so the wanted tag is at the top and nothing is hidden below a cut.
      const rank = (e) => {
        const t = (e.tag || "").toLowerCase(), d = (e.description || "").toLowerCase();
        if (t === q) return 4;
        if (t.startsWith(q)) return 3;
        if (t.includes(q)) return 2;
        if (d.includes(q)) return 1;
        return 0;
      };
      const hits = equip.map((e) => ({ e, r: rank(e) })).filter((x) => x.r > 0)
        .sort((a, b) => b.r - a.r || (a.e.tag || "").localeCompare(b.e.tag || ""))
        .map((x) => x.e);
      eqResults.innerHTML = hits.length
        ? `<div class="help" style="margin:.4rem 0 .2rem">${hits.length} match${hits.length > 1 ? "es" : ""}</div>
           <div class="card pad0" style="margin:0;max-height:320px;overflow-y:auto">${hits.map((e) => `<div class="navitem" data-eq="${e.id}"><span class="mono">${esc(e.tag)}</span>&nbsp;<span style="color:var(--muted)">${esc(e.description || "")}</span>${e.isolationStatus !== "available" ? badge(e.isolationStatus) : ""}</div>`).join("")}</div>`
        : `<div class="help">No match. ${["issuer", "admin"].includes(State.profile.role) ? '<a href="#" id="quickAdd">Add new equipment</a>' : "Ask an Issuer/Admin to add this equipment."}</div>`;
      $$("[data-eq]").forEach((d) => d.onclick = () => chooseEq(equip.find((e) => e.id === d.dataset.eq)));
      const qa = $("#quickAdd"); if (qa) qa.onclick = (e) => { e.preventDefault(); openAddEquipment(equip, (added) => { equip.push(added); chooseEq(added); }); };
    }));
    async function chooseEq(e) {
      // Cycle-based availability gate: equipment whose current work cycle is in
      // hand-back (or with earlier permits left unclosed) cannot be selected.
      // The approval gate re-checks authoritatively — this is early feedback,
      // and it runs on every pick, so it reads the live cached copy rather than
      // paying for two full collections each time an Issuer tries a tag.
      const [permits, isos] = await Promise.all([fetchPermits(), fetchIsolations().catch(() => [])]);
      const block = equipmentBlock(e.id, permits, isos, editing?.id, autoRejectPolicy());
      if (block) {
        $("#eqId").value = ""; $("#eqChosen").innerHTML = ""; eqSearch.value = ""; eqResults.innerHTML = "";
        $("#simops").innerHTML = blockBox(e.tag, block, isos);
        return;
      }
      $("#eqId").value = e.id; eqSearch.value = ""; eqResults.innerHTML = "";
      $("#eqChosen").innerHTML = `<div class="attached-list" style="margin-top:.5rem"><div class="a">
        ${ICON.cube}<b class="mono">${esc(e.tag)}</b> ${esc(e.description || "")} · ${esc(e.line)} / ${esc(e.area)}
        ${e.isolationStatus !== "available" ? badge(e.isolationStatus) : ""}
        <button class="btn btn-ghost btn-sm" id="clearEq" style="margin-left:auto">Change</button></div></div>`;
      $("#clearEq").onclick = () => { $("#eqId").value = ""; $("#eqChosen").innerHTML = ""; $("#simops").innerHTML = ""; };
      showSimops(e, permits, isos);
    }
    function showSimops(e, permits, isos) {
      // The same live set equipmentBlock() uses, auto-rejected permits excluded:
      // listing a permit here that no longer blocks anything would contradict the
      // tag having just been selectable.
      const pol = autoRejectPolicy(), isoM = isoIndex(isos);
      const activeOnEq = permits.filter((p) => p.equipmentRef === e.id && p.id !== editing?.id &&
        ["submitted", "awaitingIsolation", "active", "extended"].includes(p.status) && !isAutoRejected(p, isoM, pol));
      if (activeOnEq.length) {
        $("#simops").innerHTML = `<div class="warn-box"><b>${activeOnEq.length} live permit(s) already on ${esc(e.tag)}.</b>
          The Issuer will review concurrent work. ${e.isolationStatus === "isolated" ? "This equipment is already isolated; an isolation permit will attach to the existing isolation." : ""}
          <div class="attached-list" style="margin-top:.5rem">${activeOnEq.map((p) => `<div class="a"><span class="mono">${esc(p.permitNo)}</span> ${esc(p.typeName)} · ${esc(p.requester?.name)} ${badge(p.status)}${stageChip(permitStage(p, isos))}${isOverdue(p) ? " " + overdueChip() : ""}</div>`).join("")}</div></div>`;
      } else $("#simops").innerHTML = "";
    }
    // isolation rows
    if (type.requiresIsolation) {
      const addRow = () => { const d = document.createElement("div"); d.className = "iso-row";
        d.innerHTML = `<input placeholder="Isolation point (e.g. MCC-3 breaker)"><input placeholder="Method (rack-out / valve)"><input placeholder="Lock / tag no.">
          <button class="btn btn-ghost btn-sm">✕</button>`;
        d.querySelector("button").onclick = () => d.remove(); $("#isoRows").appendChild(d); };
      $("#addIso").onclick = addRow; addRow();
    }
    $("#saveDraft").onclick = () => savePermit("draft");
    $("#submit").onclick = () => savePermit("submitted");

    // Prefill from the draft being edited (or the permit being cloned) — only on
    // the first render. A manual permit-type change after that intentionally
    // resets the type-specific fields.
    if (source && !prefilled) {
      prefilled = true;
      if (source.requestingDepartment?.department) $("#dept").value = source.requestingDepartment.department;
      fillSub();
      if (source.requestingDepartment?.subUnit) $("#subunit").value = source.requestingDepartment.subUnit;
      $("#desc").value = source.workDescription || "";
      $("#loc").value = source.location || "";
      // A clone keeps "valid from = now" and an empty planned end. Carrying the
      // old dates over is how the replacement for a permit that timed out would
      // instantly time out again.
      if (!cloning) {
        if (source.validity?.start) $("#vstart").value = String(source.validity.start).slice(0, 16);
        if (source.validity?.openEnded) { $("#vopen").checked = true; syncOpen(); }
        else if (source.validity?.plannedEnd) $("#vend").value = String(source.validity.plannedEnd).slice(0, 16);
      }
      (source.checklist || []).forEach((c, i) => { const el = $(`[data-chk="${i}"]`); if (el) el.checked = !!c.checked; });
      const ppeSet = new Set(source.ppe || []);
      $$("[data-ppe]").forEach((el) => { el.checked = ppeSet.has(el.value); });
      if (type.requiresIsolation && (source.isolationPoints || []).length) {
        $("#isoRows").innerHTML = "";
        source.isolationPoints.forEach((pt) => {
          const d = document.createElement("div"); d.className = "iso-row";
          d.innerHTML = `<input placeholder="Isolation point (e.g. MCC-3 breaker)"><input placeholder="Method (rack-out / valve)"><input placeholder="Lock / tag no."><button class="btn btn-ghost btn-sm">✕</button>`;
          const ins = d.querySelectorAll("input");
          ins[0].value = pt.point || ""; ins[1].value = pt.method || ""; ins[2].value = pt.lockTag || "";
          d.querySelector("button").onclick = () => d.remove();
          $("#isoRows").appendChild(d);
        });
      }
      // Gas readings are never cloned. They describe the atmosphere at a moment
      // that has passed, and copying them forward would let a stale reading be
      // submitted as a current one — the one thing this form must not allow.
      if (type.requiresGasTest && source.gasTest && !cloning) {
        const g = source.gasTest;
        if ($("#g_o2")) $("#g_o2").value = g.o2 || "";
        if ($("#g_lel")) $("#g_lel").value = g.lel || "";
        if ($("#g_h2s")) $("#g_h2s").value = g.h2s || "";
        if ($("#g_co")) $("#g_co").value = g.co || "";
        if ($("#g_by")) $("#g_by").value = g.by || "";
      }
      const eqExisting = equip.find((x) => x.id === source.equipmentRef);
      if (eqExisting) chooseEq(eqExisting);
    }
  };

  async function savePermit(status) {
    const eqId = $("#eqId").value;
    if (!eqId) return toast("Select the equipment", "err");
    const desc = $("#desc").value.trim();
    if (!desc) return toast("Enter the work description", "err");
    const e = equip.find((x) => x.id === eqId);
    const checklist = type.checklist.map((c, i) => ({ item: c, checked: !!$(`[data-chk="${i}"]`)?.checked }));
    const ppe = $$("[data-ppe]:checked").map((x) => x.value);
    let isolationPoints = [];
    if (type.requiresIsolation) isolationPoints = $$("#isoRows .iso-row").map((r) => {
      const [pt, mt, lk] = [...r.querySelectorAll("input")].map((i) => i.value.trim());
      return { point: pt, method: mt, lockTag: lk };
    }).filter((x) => x.point);
    let gasTest = null;
    if (type.requiresGasTest) gasTest = { required: true, o2: $("#g_o2").value, lel: $("#g_lel").value, h2s: $("#g_h2s").value, co: $("#g_co").value, by: $("#g_by").value.trim(), time: nowISO() };
    const open = $("#vopen").checked;
    // Validation. The date range is a hard check on any save. On submit the
    // gas-test readings stay mandatory (they are safety-critical), but the
    // hazard checklist is advisory: unticked items raise a confirm rather than
    // a block, and the recorded checklist shows the Issuer exactly what was
    // and wasn't confirmed at approval time.
    const startV = $("#vstart").value || "", endV = $("#vend").value || "";
    if (!open && endV && startV && new Date(endV) <= new Date(startV)) return toast("Planned end must be after the valid-from time.", "err");
    // A submitted permit must have a planned end OR be explicitly open-ended.
    // (Previously it could silently have neither — such a permit never showed
    // as overdue and effectively never expired without being marked open.)
    if (status === "submitted" && !open && !endV)
      return toast("Set a planned end date/time, or tick Open-ended.", "err");
    if (status === "submitted" && type.requiresGasTest &&
        (!gasTest || !String(gasTest.o2).trim() || !String(gasTest.lel).trim() || !gasTest.by))
      return toast("Enter the gas-test readings (O₂, LEL) and who tested before submitting.", "err");
    // Cycle-based availability: equipment mid hand-back (or with unclosed
    // earlier permits) cannot receive a new submission. Re-checked at approval.
    if (status === "submitted") {
      // Gates a state change → server read, not the cached copy (see approvePermit).
      const [subPermits, subIsos] = await Promise.all([fetchPermits({ fresh: true }), fetchIsolations({ fresh: true }).catch(() => [])]);
      const block = equipmentBlock(eqId, subPermits, subIsos, editing?.id, autoRejectPolicy());
      if (block) return toast(`${e.tag} is not available — ${BLOCK_TEXT[block.kind]}. Earlier permit(s) must be closed first.`, "err");
    }
    // Gas-reading sanity check (advisory, like the hazard checklist): flag
    // readings outside accepted entry/hot-work limits so an unsafe atmosphere
    // is never submitted by accident. The requester can still consciously
    // proceed — the recorded values remain visible to the Issuer.
    const gasWarnings = [];
    if (status === "submitted" && gasTest) {
      const o2 = parseFloat(gasTest.o2), lel = parseFloat(gasTest.lel), h2s = parseFloat(gasTest.h2s), co = parseFloat(gasTest.co);
      if (!isNaN(o2) && (o2 < 19.5 || o2 > 23.5)) gasWarnings.push(`O₂ ${o2}% is outside the safe range (19.5–23.5%)`);
      if (!isNaN(lel) && lel >= 5) gasWarnings.push(`LEL ${lel}% is at or above the 5% action limit`);
      if (!isNaN(h2s) && h2s > 10) gasWarnings.push(`H₂S ${h2s} ppm exceeds 10 ppm`);
      if (!isNaN(co) && co > 25) gasWarnings.push(`CO ${co} ppm exceeds 25 ppm`);
    }

    const finalize = async () => {
      const requestingDepartment = { department: $("#dept").value, subUnit: $("#subunit").value || null };
      const validity = { start: $("#vstart").value || nowISO(), openEnded: open, plannedEnd: open ? null : ($("#vend").value || null), extendedTo: editing?.validity?.extendedTo ?? null };
      // Saving a DRAFT stays optimistic — it is the requester's own scratch copy,
      // queueing it offline loses nothing and the app is meant to work in the
      // plant. SUBMITTING is a lifecycle step: the Issuer has to actually receive
      // it, so it must be acknowledged by the server or reported as failed.
      const submitting = status === "submitted";
      try {
        if (editing) {
          // Update the existing draft in place. Identity / audit fields (permitNo,
          // requester, approval, createdAt…) are deliberately left untouched so the
          // write satisfies the security rules and the audit trail stays intact.
          const fields = {
            type: type.code, typeName: type.name, status,
            equipmentRef: eqId, equipmentTag: e.tag, line: e.line, area: e.area,
            requestingDepartment, workDescription: desc, location: $("#loc").value.trim(),
            validity, checklist, ppe, gasTest, isolationPoints, updatedAt: nowISO()
          };
          const ref = doc(db, "permits", editing.id);
          if (submitting) {
            await lifecycleTx("submission", async (tx) => {
              const snap = await tx.get(ref);
              if (!snap.exists()) gate("This permit no longer exists.");
              if (!["draft", "submitted"].includes(snap.data().status))
                gate(`This permit is now ${STATUS_LABEL[snap.data().status] || snap.data().status} — it can no longer be edited.`);
              // The auto-rejection clock starts when the Issuer first has
              // something to decide, and is NOT restarted by a later edit —
              // otherwise a permit could be kept alive indefinitely by touching
              // it, which is the exact thing the deadline is there to stop.
              tx.update(ref, { ...fields, submittedAt: snap.data().submittedAt || nowISO() });
            });
          } else await fsWrite(updateDoc(ref, fields));
          toast(status === "draft" ? "Draft updated" : "Permit submitted for approval", "ok");
          return go("detail", { id: editing.id });
        }
        const permit = {
          permitNo: makePermitNo(type),
          type: type.code, typeName: type.name,
          status,
          equipmentRef: eqId, equipmentTag: e.tag, line: e.line, area: e.area,
          isolationRef: null, isoNo: null,
          requester: { uid: State.profile.id, name: State.profile.name, ...myMeta() },
          requestingDepartment,
          workDescription: desc, location: $("#loc").value.trim(),
          validity,
          checklist, ppe, gasTest, isolationPoints,
          approval: null, rejection: null, closure: null, trialRuns: [],
          sync: { createdOffline: !navigator.onLine },
          // When the Issuer's clock starts. Null on a draft — a draft is waiting
          // on nobody, so it has no deadline (see autoRejectDue).
          submittedAt: submitting ? nowISO() : null,
          createdAt: nowISO(), updatedAt: nowISO()
        };
        // addDoc cannot run inside a transaction, so mint the id up front and
        // set() it — same result, and it lets a submission be transactional.
        const newRef = doc(collection(db, "permits"));
        if (submitting) await lifecycleTx("submission", async (tx) => { tx.set(newRef, permit); });
        else await fsWrite(setDoc(newRef, permit));
        toast(status === "draft" ? "Draft saved" : "Permit submitted for approval", "ok");
        go("detail", { id: newRef.id });
      } catch (err) { toast(err.message, "err"); }
    };

    // Advisory gate — warn on unticked checklist items and/or out-of-range gas
    // readings, then let the requester consciously proceed. Drafts and clean
    // submissions save straight away.
    const unconfirmed = status === "submitted" ? checklist.filter((c) => !c.checked) : [];
    const advisories = [];
    if (unconfirmed.length) advisories.push(`${unconfirmed.length} hazard-checklist item(s) are not ticked (${unconfirmed.map((c) => c.item).join("; ")}).`);
    if (gasWarnings.length) advisories.push(`GAS READINGS OUT OF RANGE: ${gasWarnings.join("; ")}.`);
    if (advisories.length) {
      return confirmBox("Submit with unconfirmed items?",
        `${advisories.join(" ")} The Issuer will see these when reviewing. Submit for approval anyway?`,
        "Submit anyway", () => { closeModal(); return finalize(); });
    }
    return finalize();
  }
  draw();
}
function makePermitNo(type) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `NRCC-${type.abbr}-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// The Isolator's re-isolation dialog, shared by the permit and the certificate.
//
// Re-isolating is never blocked. Putting locks back on is the safe direction and
// must not wait for anyone else's signature — an Isolator may need to do it
// because they saw something wrong, because the crew walked off, or because of
// something happening elsewhere on the plant.
//
// But doing it before the crew has said the trial is finished cuts their test
// short, so it is a deliberate act rather than a quiet one: the dialog says what
// it will interrupt and asks for an explicit tick. The record then shows which
// of the two it was — see trialHistoryHTML.
function reIsolateDialog(tagText, trial, onOk) {
  const t = trial || {};
  const live = `<div class="danger-box"><b>${esc(tagText)} is ENERGISED.</b></div>`;
  if (t.completedBy) {
    return confirmBoxHTML("Re-isolate after trial run",
      `${live}<div class="ok-box"><b>The crew has confirmed the trial is finished</b> — ${personHTML(t.completedBy.name, t.completedBy)} · ${fmt(t.completedAt)}.${t.completionRemarks ? " " + esc(t.completionRemarks) : ""}</div>
       <p>Confirm the locks and tags are back on and the equipment is safe. Work may then resume on every permit attached to this certificate.</p>`,
      "Confirm re-isolated", onOk);
  }
  modal({ title: "Re-isolate — the crew has not signed off", wide: true, body: `
    ${live}
    <div class="warn-box"><b>${esc(t.requestedBy?.name || "The crew")} has not confirmed the trial is finished.</b>
      They may still be running it. Re-isolating now stops the trial${t.permitNo ? ` on <span class="mono">${esc(t.permitNo)}</span>` : ""} — they would have to raise a new one to try again.
      ${t.reason ? `<div style="margin-top:.35rem">Trial reason: ${esc(t.reason)}</div>` : ""}</div>
    <p>Go ahead if the equipment needs to be made safe. Otherwise, check with the crew first.</p>
    <label class="checkline"><input type="checkbox" id="riEarly"> I am re-isolating before the crew has signed off</label>
    <label class="checkline"><input type="checkbox" id="riOn"> The locks and tags are back on and the equipment is safe</label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Re-isolate anyway</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = () => {
    if (!($("#riEarly").checked && $("#riOn").checked)) return toast("Confirm both checks", "err");
    onOk();
  };
}

// The trial run in flight, shown on the certificate — where an Isolator has to
// decide whether the equipment may be energised. It states plainly which crews
// have cleared and which have not, because that list is the whole basis of the
// decision, and prints the state of the locks rather than a stage name.
function trialLiveHTML(iso, permits) {
  const t = iso && iso.trialRun;
  if (!t) return "";
  const c = trialConsentState(iso, permits || []);
  const line = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const names = (arr) => arr.map((p) => `<span class="mono">${esc(p.permitNo || p.id)}</span>`).join(", ") || "—";
  const live = isTrialEnergised(iso);
  return `<div class="card"><h3>Trial run ${live ? "— IN PROGRESS" : "requested"}</h3>
    ${line("Locks", live
      ? `<b style="color:var(--red)">OUT — equipment ENERGISED</b>`
      : `<b>ON — equipment still isolated</b>`)}
    ${line("Requested by", `${personHTML(t.requestedBy?.name, t.requestedBy)}${t.permitNo ? ` on <span class="mono">${esc(t.permitNo)}</span>` : ""} · ${fmt(t.requestedAt)}`)}
    ${(() => { const o = trialOverrun(iso); if (!live && !t.expectedMinutes) return "";
      if (!live) return line("Expected to take", `${esc(String(t.expectedMinutes))} min`);
      if (!o) return "";
      return line("Running for", `${o.elapsed} min${o.stated ? ` of the ${o.expected} min asked for` : ""}${o.over ? ` — <b style="color:var(--red)">OVERRUN</b>` : ""}`); })()}
    ${t.reason ? line("Reason", esc(t.reason)) : ""}
    ${line("Crews cleared", names(c.given))}
    ${line("Still to clear", c.outstanding.length ? `<b>${names(c.outstanding)}</b>` : "None — every crew has cleared")}
    ${line("Issuer authorisation", t.issuerApproval
      ? `${personHTML(t.issuerApproval.name, t.issuerApproval)} · ${fmt(t.issuerApproval.at)}`
      : "<b>Not yet authorised</b>")}
    ${t.deisolatedBy ? line("Locks removed by", `${personHTML(t.deisolatedBy.name, t.deisolatedBy)} · ${fmt(t.deisolatedAt)}`) : ""}
    ${live ? line("Trial finished?", t.completedBy
      ? `<b style="color:var(--green)">YES — confirmed by ${personHTML(t.completedBy.name, t.completedBy)} · ${fmt(t.completedAt)}</b>${t.completionRemarks ? `<div>${esc(t.completionRemarks)}</div>` : ""}<div>Re-apply the locks.</div>`
      : "Not yet — the crew has not confirmed the trial is finished") : ""}
  </div>`;
}

// Every trial run this lockout has seen, newest last: the completed/refused/
// cancelled ones from the certificate, plus the one in flight. `permit` supplies
// the legacy fallback — trials started by the first version of this feature were
// recorded on the permit, and those records must not disappear from the audit
// trail just because the state moved to the certificate.
// Every trial run this lockout has seen, oldest first: the legacy per-permit
// records, then the certificate's closed log, then the one in flight. Shared by
// the on-screen log and the printed one so a signed print can never show a
// different history from the screen it was printed from.
function trialRecords(iso, permit) {
  const legacy = (permit?.trialRuns || []).map((t) => ({
    legacy: true, requestedAt: t.authorisedAt || t.requestedAt, permitNo: permit.permitNo,
    requestedBy: { name: t.authorisedBy, ...(t.authorisedByMeta || {}) },
    reIsolatedAt: t.reIsolatedAt, status: t.status,
    outcome: t.reIsolatedAt ? "completed" : null
  }));
  const rows = [...(iso?.trialRunLog || [])];
  if (iso?.trialRun) rows.push(iso.trialRun);
  return [...legacy, ...rows];
}

function trialHistoryHTML(iso, permit) {
  const all = trialRecords(iso, permit);
  if (!all.length) return "";
  const OUTCOME = { completed: `<span class="chip chip-ok">✔ Completed</span>`,
    refused: `<span class="chip">Refused by a crew</span>`,
    cancelled: `<span class="chip">Cancelled</span>`,
    abandoned: `<span class="chip">Abandoned</span>` };
  return `<div class="card"><h3>Trial run log</h3>
    ${all.map((t) => {
      const answers = (t.consents || []).filter((c) => c && c.decision !== "requested");
      return `<div class="kv"><div class="k">${fmt(t.requestedAt)}</div><div class="v">
        ${t.permitNo ? `<span class="mono">${esc(t.permitNo)}</span> · ` : ""}
        Requested by ${personHTML(t.requestedBy?.name, t.requestedBy)}
        ${OUTCOME[t.outcome] || `<span class="chip chip-prog">● ${esc(STATUS_LABEL[t.status] || t.status || "open")}</span>`}
        ${t.reason ? `<div>${esc(t.reason)}</div>` : ""}
        ${answers.length ? `<div>Crews: ${answers.map((c) => `<span class="mono">${esc(c.permitNo || c.permitId || "")}</span> ${c.decision === "refuse" ? "refused" : "cleared"}`).join(" · ")}</div>` : ""}
        ${t.issuerApproval ? `<div>Authorised by ${personHTML(t.issuerApproval.name, t.issuerApproval)} · ${fmt(t.issuerApproval.at)}</div>` : ""}
        ${t.deisolatedBy ? `<div>Locks removed by ${personHTML(t.deisolatedBy.name, t.deisolatedBy)} · ${fmt(t.deisolatedAt)}</div>` : ""}
        ${t.completedBy ? `<div>Crew confirmed finished by ${personHTML(t.completedBy.name, t.completedBy)} · ${fmt(t.completedAt)}${t.completionRemarks ? " — " + esc(t.completionRemarks) : ""}</div>`
          : t.outcome === "completed" && !t.legacy && t.reIsolatedBy
            ? `<div><b>Re-isolated before the crew confirmed the trial was finished.</b></div>` : ""}
        ${t.reIsolatedBy ? `<div>Re-isolated by ${personHTML(t.reIsolatedBy.name, t.reIsolatedBy)} · ${fmt(t.reIsolatedAt)}</div>`
          : t.reIsolatedAt ? `<div>Re-isolated ${fmt(t.reIsolatedAt)}</div>`
          : t.outcome ? "" : `<div><b>OPEN — equipment energised</b></div>`}
        ${t.closedBy ? `<div>Closed by ${personHTML(t.closedBy.name, t.closedBy)} · ${fmt(t.closedAt)}${t.closeReason ? " — " + esc(t.closeReason) : ""}</div>` : ""}
        ${t.legacy ? `<div class="help">Recorded by the earlier trial-run flow.</div>` : ""}
      </div></div>`;
    }).join("")}</div>`;
}

/* -------------------- 5d. Permit Detail -------------------- */
async function viewPermitDetail(m) {
  m.innerHTML = `<div id="pd">Loading…</div>`;
  const id = State.params.id;
  const snap = await getDoc(doc(db, "permits", id));
  if (!snap.exists()) { $("#pd").innerHTML = `<div class="danger-box">Permit not found.</div>`; return; }
  const p = { id, ...snap.data() };
  const isIssuer = ["issuer", "admin"].includes(State.profile.role);
  const isOwner = p.requester?.uid === State.profile.id;
  // De-isolation is the Isolator's job; Admin kept only as a superuser fallback.
  const isIsoOrAdmin = ["isolator", "admin"].includes(State.profile.role);
  // Equipment, certificate and the sibling-permit list all hang off the permit
  // we just loaded but not off each other, so fetch them concurrently rather
  // than paying a separate round trip for each.
  const [eqSnap, isoSnap, sharedPermits] = await Promise.all([
    getDoc(doc(db, "equipment", p.equipmentRef)).catch(() => null),
    p.isolationRef ? getDoc(doc(db, "isolations", p.isolationRef)).catch(() => null) : null,
    p.isolationRef ? fetchPermits() : null
  ]);
  const equip = eqSnap && eqSnap.exists() ? { id: eqSnap.id, ...eqSnap.data() } : null;
  const isoDoc = isoSnap && isoSnap.exists() ? { id: isoSnap.id, ...isoSnap.data() } : null;
  // Trial-run state comes off the CERTIFICATE, so every crew sharing the
  // lockout sees the same thing on their own permit — not only the crew that
  // asked for it.
  const trialAt = trialStage(isoDoc);
  const energised = isTrialEnergised(isoDoc);
  const onCert = (sharedPermits || []).filter((x) => x.isolationRef === p.isolationRef);
  const trialC = trialConsentState(isoDoc, onCert);
  const iAmAsked = trialAt === "requested" && isOwner && trialC.outstanding.some((x) => x.id === p.id);
  const iAsked = isoDoc?.trialRun?.requestedBy?.uid === State.profile.id;
  const trialClear = !trialC.outstanding.length && !trialC.refused.length;
  // Every permit the transaction should re-read: the crews this page can see.
  const crewIds = onCert.map((x) => x.id);

  // Hand-back order: requester confirms work complete → Isolator de-isolates →
  // Issuer closes. The equipment is de-isolated when there is no certificate or
  // its certificate has been removed.
  const deisolated = !p.isolationRef || (isoDoc && isoDoc.status === "removed");
  const awaitingDeiso = ["active", "extended"].includes(p.status) && p.workCompletion && !deisolated;
  // For a shared certificate, de-isolation only opens once every crew has signed
  // off. Work that out so we can show whether it's ready now or waiting on others.
  let deisoReady = false;
  // Load every permit sharing this isolation certificate. A single lockout often
  // covers several crews (several permits), and each crew only sees their own
  // permit. When their work is done but the equipment stays isolated — because
  // OTHER crews are still working — it can look like a system fault. Showing the
  // sibling permits here gives the whole picture in one place, and lets us fetch
  // once for both that list and the shared-cert de-isolation readiness check.
  let siblings = [];
  if (p.isolationRef && sharedPermits) {
    siblings = sharedPermits.filter((x) => x.isolationRef === p.isolationRef && x.id !== id);
    if (awaitingDeiso && isoDoc) deisoReady = isoDoc.status === "removalPending" || isoReadyForDeiso(isoDoc, sharedPermits);
  }
  const shared = siblings.length > 0;
  const siblingsWorking = siblings.filter((x) => ["active", "extended"].includes(x.status) && !x.workCompletion).length;
  // Auto-rejection, derived from this permit's own certificate — the only lockout
  // that can hold it, and the same one its siblings are under. Worked out once:
  // workChip below runs per sibling row.
  const arPol = autoRejectPolicy();
  const arIsos = isoDoc ? [isoDoc] : [];
  // A compact "is this crew finished?" indicator for the sibling-permit table.
  // permitDead rather than a status list: a sibling that has auto-rejected but
  // has not been stamped yet is finished, and showing it as "Not started" would
  // suggest a crew is still expected on a lockout that is only waiting on itself.
  const workChip = (x) => {
    if (x.status === "closed") return `<span class="chip">Closed</span>`;
    if (permitDead(x, arIsos, arPol)) return `<span class="chip">—</span>`;
    if (["active", "extended"].includes(x.status)) return x.workCompletion
      ? `<span class="chip chip-ok">✔ Work complete</span>`
      : `<span class="chip chip-prog">● In progress</span>`;
    return `<span class="chip">Not started</span>`;
  };
  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  // `arDead` is the gate: past the deadline AND safe to act on (see autoRejectSafe).
  const arState = autoRejectState(p, arIsos, arPol);
  const arDead = arState?.phase === "lapsed";
  // Reinstatement is offered while the permit still points at nothing physical:
  // once it is stamped its certificate has been cancelled, so putting it back
  // means a fresh approval and a fresh certificate, not a status flip.
  // Measured from when it was STAMPED, not from the deadline it missed: a permit
  // that lapsed over a shutdown may not be seen for days, and the window is meant
  // to cover "an Issuer has just looked at this and it is wrong", not the lapse.
  const arReinstatable = p.status === "expired" && isIssuer &&
    (Date.now() - Date.parse(p.autoReject?.stampedAt || p.updatedAt || "")) < (arPol.reinstateHours || 0) * 3600000;
  let actions = "";
  // An auto-rejected permit cannot be approved. This is the load-bearing line of
  // the whole feature: everything else is presentation, but approving a permit
  // whose window has already closed is the outcome worth preventing.
  if (p.status === "submitted" && isIssuer && !arDead) actions += `<button class="btn btn-success" id="approve">Approve</button>`;
  if (["submitted", "awaitingIsolation"].includes(p.status) && isIssuer) actions += `<button class="btn btn-danger" id="reject">Reject</button>`;
  if (arReinstatable) actions += `<button class="btn btn-accent" id="reinstate">Reinstate</button>`;
  // Anyone who can raise a permit can raise the replacement, without retyping it —
  // except Confined Space Entry, which is Admin-only to raise (cosmetic gate,
  // see viewNewPermit's visibleTypes / clone guard for the matching checks).
  if ((arDead || p.status === "expired") && (isOwner || isIssuer) && (p.type !== "confined" || isAdmin()))
    actions += `<button class="btn btn-ghost" id="clonePermit">Raise a new permit from this</button>`;
  if (["draft"].includes(p.status) && isOwner) actions += `<button class="btn btn-ghost" id="editDraft">Edit</button><button class="btn btn-accent" id="submitNow">Submit for approval</button>`;
  // The requester signs off that the work is finished and the equipment is safe
  // to return to service. The Issuer can only close after de-isolation.
  if (["active", "extended"].includes(p.status) && isOwner && !p.workCompletion) actions += `<button class="btn btn-success" id="workdone">Confirm work complete</button>`;
  if (awaitingDeiso && deisoReady && isIsoOrAdmin) actions += `<button class="btn btn-accent" id="godeiso">Go to de-isolation</button>`;
  if (["active", "extended"].includes(p.status) && isIssuer) {
    // Once work is complete AND the equipment is de-isolated the permit is
    // ready to close — extending it is meaningless, so only offer Close.
    if (!(p.workCompletion && deisolated)) actions += `<button class="btn btn-ghost" id="extend">Extend</button>`;
    if (p.workCompletion && deisolated) actions += `<button class="btn btn-primary" id="close">Close permit</button>`;
  }
  // Trial run. Each role sees only its own step: the crew asks, the other crews
  // clear, the Issuer authorises, the Isolator takes the locks out and puts
  // them back. Nobody is offered someone else's step.
  const permitLive = ["active", "extended"].includes(p.status);
  if (permitLive && p.isolationRef && isOwner && !trialAt && !energised)
    actions += `<button class="btn btn-danger" id="trialReq">Request trial run</button>`;
  if (iAmAsked)
    actions += `<button class="btn btn-success" id="trialYes">My crew is clear</button><button class="btn btn-danger" id="trialNo">Refuse</button>`;
  if (trialAt === "requested" && isIssuer && trialClear)
    actions += `<button class="btn btn-danger" id="trialOk">Authorise trial run</button>`;
  if (["requested", "approved"].includes(trialAt) && (iAsked || isIssuer))
    actions += `<button class="btn btn-ghost" id="trialCancel">Cancel trial run</button>`;
  if (trialAt === "approved" && isIsoOrAdmin)
    actions += `<button class="btn btn-danger" id="trialGo">De-isolate for trial run</button>`;
  // The crew that asked says when the trial has proved what it needed to. It is
  // a signal to the Isolator, not a state change — the equipment stays live.
  const trialDone = !!isoDoc?.trialRun?.completedBy;
  if (energised && trialAt === "energised" && !trialDone && (iAsked || isIssuer))
    actions += `<button class="btn btn-accent" id="trialDone">Trial run complete</button>`;
  if (energised && isIsoOrAdmin)
    actions += `<button class="btn btn-success" id="reiso">Re-isolate now</button>`;
  actions += `<button class="btn btn-ghost no-print" id="pdf">${ICON.pdf} Print / PDF</button>`;

  $("#pd").innerHTML = `
    <div class="page-head"><div><div class="kick">Permit · ${esc(p.typeName)}</div>
      <h2 style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap"><span class="mono" style="font-size:1.1rem">${esc(p.permitNo)}</span> ${badge(p.status)}${trialChip(isoDoc)}${autoRejectChip(arState)}</h2></div>
      <div class="actions">${actions}</div></div>

    ${p.rejection ? `<div class="danger-box"><b>Rejected.</b> ${esc(p.rejection.reason || "")} <span style="color:var(--muted)">— ${personHTML(p.rejection.byName, p.rejection)}, ${fmt(p.rejection.timestamp)}</span></div>` : ""}
    ${arDead || p.status === "expired" ? `<div class="danger-box"><b>Auto-rejected.</b> This permit was never approved — ${esc(AUTO_REJECT_RULE[arState?.rule || p.autoReject?.rule] || "it ran out of time")}${arState ? ` (${esc(fmt(new Date(arState.at).toISOString()))})` : p.autoReject?.at ? ` (${esc(fmt(p.autoReject.at))})` : ""}.
      <div style="margin-top:.35rem">Nobody rejected it — it lapsed on time, so no reason is recorded against anyone. ${p.equipmentTag ? `<b>${esc(p.equipmentTag)}</b> is released for new permits.` : ""}
      ${isOwner ? "The work has not been authorised. Raise a new permit with current dates and a fresh gas test if it is still needed." : isIssuer ? "Reinstate it if it lapsed in error, or ask the requester to raise a new one." : ""}</div>
      ${p.autoReject?.reinstatedBy ? `<div style="margin-top:.35rem">Previously reinstated by ${personHTML(p.autoReject.reinstatedBy.name, p.autoReject.reinstatedBy)} · ${fmt(p.autoReject.reinstatedAt)}.</div>` : ""}</div>` : ""}
    ${arState?.phase === "held" ? `<div class="danger-box"><b>Past its auto-reject deadline — held for a person.</b> This permit passed its deadline (${esc(fmt(new Date(arState.at).toISOString()))}) but it is attached to certificate <span class="mono">${esc(p.isoNo || p.isolationRef || "")}</span>, which is either already applied or shared with another crew.
      <div style="margin-top:.35rem">Nothing has been decided automatically, because doing so would mean deciding that physical locks should move. ${isIssuer ? "Approve it, or reject it with a reason, or extend the validity." : "It is with the Issuer."}</div></div>` : ""}
    ${arState?.phase === "warn" ? `<div class="warn-box"><b>Auto-rejects in ${esc(hoursText(arState.at - Date.now()))}</b> — ${esc(fmt(new Date(arState.at).toISOString()))}, because ${arState.rule === "plannedEnd" ? "that is the planned end on the permit itself" : "no decision has been recorded"}.
      ${isIssuer ? "Approve or reject it before then." : "It is still waiting for a decision — chase the Issuer if the work is due."}</div>` : ""}
    ${isOverdue(p) ? `<div class="danger-box"><b>Permit overdue.</b> The planned end (${fmt(permitEnd(p))}) has passed. ${isIssuer ? "Extend the validity or close the permit." : "Ask the Issuer to extend or close this permit."}</div>` : ""}
    ${energised ? `<div class="danger-box"><b>⚠ TRIAL RUN IN PROGRESS — ${esc(p.equipmentTag || equip?.tag || "the equipment")} is ENERGISED.</b>
      Do not work on it and keep clear. ${isIsoOrAdmin ? "Re-isolate as soon as the trial is finished." : "An Isolator must re-isolate before any work resumes."}
      ${isoDoc?.trialRun?.deisolatedBy ? `<div style="margin-top:.35rem">Locks removed by ${personHTML(isoDoc.trialRun.deisolatedBy.name, isoDoc.trialRun.deisolatedBy)} · ${fmt(isoDoc.trialRun.deisolatedAt)}${isoDoc.trialRun.permitNo ? ` for <span class="mono">${esc(isoDoc.trialRun.permitNo)}</span>` : ""}.</div>` : ""}
      ${trialDone ? `<div style="margin-top:.35rem"><b>The crew has confirmed the trial is finished</b> — ${personHTML(isoDoc.trialRun.completedBy.name, isoDoc.trialRun.completedBy)} · ${fmt(isoDoc.trialRun.completedAt)}.${isoDoc.trialRun.completionRemarks ? " " + esc(isoDoc.trialRun.completionRemarks) : ""} Awaiting an Isolator to re-apply the locks. <b>The equipment is still ENERGISED until they do.</b></div>`
        : iAsked ? `<div style="margin-top:.35rem">When the trial has proved what you needed, tap <b>Trial run complete</b> so an Isolator knows to re-isolate.</div>` : ""}</div>` : ""}
    ${trialAt === "requested" ? `<div class="warn-box"><b>Trial run requested</b> by ${personHTML(isoDoc.trialRun.requestedBy?.name, isoDoc.trialRun.requestedBy)}${isoDoc.trialRun.permitNo ? ` on <span class="mono">${esc(isoDoc.trialRun.permitNo)}</span>` : ""} · ${fmt(isoDoc.trialRun.requestedAt)}.
      ${isoDoc.trialRun.reason ? `<div style="margin-top:.35rem">${esc(isoDoc.trialRun.reason)}</div>` : ""}
      <div style="margin-top:.35rem">${trialC.outstanding.length
        ? `Waiting on <b>${trialC.outstanding.length} crew(s)</b> to clear: ${trialC.outstanding.map((x) => `<span class="mono">${esc(x.permitNo || x.id)}</span>`).join(", ")}.`
        : `<b>All crews have cleared.</b> ${isIssuer ? "Authorise the trial run when you are satisfied." : "Awaiting the Issuer's authorisation."}`}</div>
      ${iAmAsked ? `<div style="margin-top:.35rem"><b>Your crew has not answered.</b> Confirm your people are clear of ${esc(p.equipmentTag || "the equipment")}, or refuse.</div>` : ""}
      <div style="margin-top:.35rem">The equipment is <b>still isolated</b> — the locks do not come out until an Isolator removes them.</div></div>` : ""}
    ${trialAt === "approved" ? `<div class="warn-box"><b>Trial run authorised</b> by ${personHTML(isoDoc.trialRun.issuerApproval?.name, isoDoc.trialRun.issuerApproval)} · ${fmt(isoDoc.trialRun.issuerApproval?.at)}.
      <b>The equipment is still isolated.</b> An Isolator must remove the locks before it is energised${isIsoOrAdmin ? " — use <b>De-isolate for trial run</b> when every crew is confirmed clear." : "."}</div>` : ""}
    ${p.status === "awaitingIsolation" ? `<div class="warn-box"><b>Awaiting isolation.</b> Certificate <span class="mono">${esc(p.isoNo || "")}</span> is assigned to <b>${personHTML(isoDoc?.assignedTo?.name, isoDoc?.assignedTo)}</b> — the permit activates automatically when the isolation is confirmed.</div>` : ""}
    ${["active", "extended"].includes(p.status) && !p.workCompletion ? `<div class="warn-box"><b>Awaiting work-completion confirmation.</b> ${isOwner ? "When the job is finished, tap <b>Confirm work complete</b> to confirm the equipment is safe to return to service." : "The requester must confirm the work is complete and the equipment is safe before the permit can be closed."}</div>` : ""}
    ${awaitingDeiso ? `<div class="warn-box"><b>Work complete — awaiting de-isolation.</b> Confirmed by ${personHTML(p.workCompletion.name, p.workCompletion)} · ${fmt(p.workCompletion.timestamp)}.${p.workCompletion.remarks ? " " + esc(p.workCompletion.remarks) : ""} <b>Locks are still on.</b> ${deisoReady ? `An Isolator must de-isolate <span class="mono">${esc(p.equipmentTag || "")}</span> on certificate <a href="#" data-isolink3 class="mono">${esc(p.isoNo || p.isolationRef)}</a> before this permit can be closed.` : `<b>This is expected, not a fault.</b> ${esc(p.equipmentTag || "")} is on a <b>shared isolation</b> with ${siblings.length} other permit(s)${siblingsWorking ? ` — <b>${siblingsWorking} still in progress</b>` : ""}. The locks stay ON until every crew confirms work complete. See <b>Other permits on this isolation</b> below.`}</div>` : ""}
    ${["active", "extended"].includes(p.status) && p.workCompletion && deisolated ? `<div class="ok-box"><b>Work complete${p.isolationRef ? " and equipment de-isolated" : ""} — confirmed by ${personHTML(p.workCompletion.name, p.workCompletion)}</b> · ${fmt(p.workCompletion.timestamp)}.${p.workCompletion.remarks ? " " + esc(p.workCompletion.remarks) : ""} The Issuer may now close the permit.</div>` : ""}

    <div class="cols cols-2">
      <div class="card"><h3>Details</h3>
        ${kv("Equipment", `<span class="mono">${esc(p.equipmentTag)}</span> ${equip ? "· " + esc(equip.line) + " / " + esc(equip.area) : ""}`)}
        ${p.isoNo ? kv("Isolation cert.", `<a href="#" data-isolink class="mono">${esc(p.isoNo)}</a>`) : ""}
        ${kv("Requester", personHTML(p.requester?.name, p.requester))}
        ${kv("Department", esc(p.requestingDepartment?.department || "—") + (p.requestingDepartment?.subUnit ? " · " + esc(p.requestingDepartment.subUnit) : ""))}
        ${kv("Work", esc(p.workDescription))}
        ${p.location ? kv("Location", esc(p.location)) : ""}
        ${kv("Valid from", fmt(p.validity?.start))}
        ${kv("Valid to", p.validity?.openEnded ? "Open (while active)" : fmt(p.validity?.extendedTo || p.validity?.plannedEnd))}
        ${p.approval ? kv("Approved by", personHTML(p.approval.issuerName, p.approval) + " · " + fmt(p.approval.timestamp)) : ""}
        ${p.workCompletion ? kv("Work completed", personHTML(p.workCompletion.name, p.workCompletion) + " · " + fmt(p.workCompletion.timestamp) + (p.workCompletion.remarks ? " · " + esc(p.workCompletion.remarks) : "")) : ""}
        ${p.closure ? kv("Closed by", personHTML(p.closure.name, p.closure) + " · " + fmt(p.closure.timestamp) + (p.closure.remarks ? " · " + esc(p.closure.remarks) : "")) : ""}
      </div>
      <div class="card"><h3>Hazard checklist</h3>
        ${(() => { const u = (p.checklist || []).filter((c) => !c.checked).length;
          return u ? `<div class="warn-box"><b>${u} item(s) not confirmed by the requester.</b> Review before approving.</div>` : ""; })()}
        ${(p.checklist || []).map((c) => `<div class="checkline">${c.checked ? "☑" : "☐"} ${esc(c.item)}</div>`).join("") || "<div class='help'>None</div>"}
        <div class="section-title">PPE</div>
        ${(p.ppe || []).length ? p.ppe.map((x) => `<span class="chip">${esc(x)}</span> `).join("") : "<span class='help'>None specified</span>"}
        ${p.gasTest ? `<div class="section-title">Gas test</div>
          <div class="kv"><div class="k">O₂ / LEL / H₂S / CO</div><div class="v">${esc(p.gasTest.o2 || "—")} / ${esc(p.gasTest.lel || "—")} / ${esc(p.gasTest.h2s || "—")} / ${esc(p.gasTest.co || "—")}</div></div>
          ${p.gasTest.by ? `<div class="kv"><div class="k">Tested by</div><div class="v">${esc(p.gasTest.by)}</div></div>` : ""}` : ""}
      </div>
    </div>

    ${p.isolationPoints?.length || p.isolationRef ? `<div class="card"><h3>Isolation / LOTO</h3>
      ${p.isolationRef ? `<div class="info-box">Isolation certificate <a href="#" data-isolink2 class="mono">${esc(p.isoNo || p.isolationRef)}</a> on ${esc(p.equipmentTag)}${isoDoc ? " — " + (isoDoc.status === "assigned" ? "awaiting confirmation by " + personHTML(isoDoc.assignedTo?.name, isoDoc.assignedTo) : "status: " + esc(isoDoc.status)) : ""}.</div>` : ""}
      <table class="tbl"><thead><tr><th>Point</th><th>Method</th><th>Lock / tag</th></tr></thead><tbody>
        ${(p.isolationPoints || []).map((i) => `<tr><td>${esc(i.point)}</td><td>${esc(i.method || "—")}</td><td>${esc(i.lockTag || "—")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No points listed</td></tr>`}
      </tbody></table></div>` : ""}

    ${shared ? `<div class="card"><h3>Other permits on this isolation (${siblings.length})</h3>
      <div class="info-box">These crews share isolation certificate <a href="#" data-isolink4 class="mono">${esc(p.isoNo || p.isolationRef)}</a> on <span class="mono">${esc(p.equipmentTag)}</span>. The equipment stays isolated (locks ON) until <b>every</b> permit listed here is confirmed work-complete — so your own permit alone does not release it.</div>
      <table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Requester</th><th>Status</th><th>Work</th></tr></thead><tbody>
        ${siblings.map((s) => `<tr class="row" data-sib="${s.id}">
          <td><span class="mono">${esc(s.permitNo)}</span></td>
          <td><span class="type-pill"><span class="dot" style="background:${TYPE_DOT[s.type]}"></span>${esc(s.typeName || s.type)}</span></td>
          <td>${esc(s.requester?.name || "—")}</td>
          <td>${badge(s.status)}${isOverdue(s) ? " " + overdueChip() : ""}</td>
          <td>${workChip(s)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}

    ${trialHistoryHTML(isoDoc, p)}
  `;

  // bind actions
  $("#pdf") && ($("#pdf").onclick = () => printPermit(p, equip, isoDoc));
  $$("[data-isolink],[data-isolink2],[data-isolink3],[data-isolink4]").forEach((a) => a.onclick = (e) => { e.preventDefault(); go("isodetail", { id: p.isolationRef }); });
  $$("tr.row[data-sib]").forEach((r) => r.onclick = () => go("detail", { id: r.dataset.sib }));
  $("#godeiso") && ($("#godeiso").onclick = () => go("isodetail", { id: p.isolationRef }));
  $("#editDraft") && ($("#editDraft").onclick = () => go("new", { editId: id }));
  $("#clonePermit") && ($("#clonePermit").onclick = () => go("new", { cloneId: id }));
  $("#reinstate") && ($("#reinstate").onclick = () => reinstatePermit(p));
  // Opportunistic stamp. The derived state above is already authoritative for
  // every gate, so this only makes the record permanent — and it is deliberately
  // fire-and-forget: it must never block the page, and a failure (offline, or a
  // race with somebody approving) simply leaves the derivation in charge.
  if (arDead && isIssuer && p.status !== "expired") stampAutoReject(p, isoDoc);
  $("#submitNow") && ($("#submitNow").onclick = async () => {
    // Gates a state change → server read, not the cached copy (see approvePermit).
    const [subPermits, subIsos] = await Promise.all([fetchPermits({ fresh: true }), fetchIsolations({ fresh: true }).catch(() => [])]);
    const block = equipmentBlock(p.equipmentRef, subPermits, subIsos, p.id, autoRejectPolicy());
    if (block) return toast(`${p.equipmentTag} is not available — ${BLOCK_TEXT[block.kind]}. Earlier permit(s) must be closed first.`, "err");
    try {
      await lifecycleTx("submission", async (tx) => {
        const ref = doc(db, "permits", id);
        const snap = await tx.get(ref);
        if (!snap.exists()) gate("This permit no longer exists.");
        if (snap.data().status !== "draft")
          gate(`This permit is now ${STATUS_LABEL[snap.data().status] || snap.data().status} — it was not submitted again.`);
        tx.update(ref, { status: "submitted", submittedAt: nowISO(), updatedAt: nowISO() });
      });
      toast("Submitted", "ok"); go("detail", { id });
    } catch (e) { toast(e.message || "Could not submit the permit", "err"); }
  });
  $("#reject") && ($("#reject").onclick = () => {
    modal({ title: "Reject permit", body: `<label class="field"><span>Reason</span><textarea id="rr" placeholder="Why is this being rejected?"></textarea></label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>Reject</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = async () => {
      const reason = $("#rr").value.trim();
      try {
        // The certificate side effects here decide whether locks stay on, so the
        // read and the write have to be one atomic unit: re-read the permit and
        // its certificate inside the transaction rather than trusting the copy
        // this page loaded.
        await lifecycleTx("rejection", async (tx) => {
          const pRef = doc(db, "permits", id);
          const pSnap = await tx.get(pRef);
          if (!pSnap.exists()) gate("This permit no longer exists.");
          const cur = pSnap.data();
          if (!["submitted", "awaitingIsolation"].includes(cur.status))
            gate(`This permit is now ${STATUS_LABEL[cur.status] || cur.status} — it was not rejected.`);
          const isoRef = cur.isolationRef ? doc(db, "isolations", cur.isolationRef) : null;
          const iSnap = isoRef ? await tx.get(isoRef) : null;
          const eqRef = cur.equipmentRef ? doc(db, "equipment", cur.equipmentRef) : null;
          // Read the equipment before any write — a transaction may not read
          // after it has written.
          const eqSnap = eqRef && iSnap && iSnap.exists() ? await tx.get(eqRef) : null;

          tx.update(pRef, { status: "rejected", rejection: { by: State.profile.id, byName: State.profile.name, ...myMeta(), reason, timestamp: nowISO() }, updatedAt: nowISO() });
          if (iSnap && iSnap.exists()) {
            const isoX = iSnap.data();
            const remCount = (isoX.attachedPermitIds || []).filter((x) => x !== id).length;
            if (remCount) tx.update(isoRef, { attachedPermitIds: arrayRemove(id) });
            else if (isoX.status === "assigned") {
              // Locks were never applied — cancel the certificate and free the
              // equipment, but only if it still points at THIS certificate.
              tx.update(isoRef, { attachedPermitIds: [], status: "removed", removedAt: nowISO(), removalConfirmedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() }, removalNote: "Cancelled — permit rejected before isolation" });
              if (eqSnap && eqSnap.exists() && eqSnap.data().activeIsolationId === cur.isolationRef)
                tx.update(eqRef, { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
            } else if (isoX.status !== "removed") {
              // Locks are physically ON with no permits left — an Isolator must
              // still remove them, so the certificate goes to de-isolation.
              tx.update(isoRef, { attachedPermitIds: [], status: "removalPending" });
            }
          }
        });
        closeModal(); toast("Permit rejected"); go("detail", { id }); refreshPendingBadge();
      } catch (e) { toast(e.message || "Could not reject the permit", "err"); }
    };
  });
  $("#approve") && ($("#approve").onclick = () => approvePermit(p, equip));
  $("#extend") && ($("#extend").onclick = () => {
    const curEnd = (p.validity?.extendedTo || p.validity?.plannedEnd || "").slice(0, 16);
    modal({ title: "Extend permit", body: `<label class="field"><span>New end date/time</span><input type="datetime-local" id="ne" value="${curEnd}"></label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-primary" data-ok>Extend</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = async () => {
      const ne = $("#ne").value;
      if (!ne) return toast("Pick a new end date/time", "err");
      if (new Date(ne) <= new Date()) return toast("The new end must be in the future.", "err");
      try {
        await lifecycleTx("extension", async (tx) => {
          const ref = doc(db, "permits", id);
          const snap = await tx.get(ref);
          if (!snap.exists()) gate("This permit no longer exists.");
          // Extending a permit that has since been closed or rejected would put
          // it back into a live state — refuse.
          if (!["active", "extended"].includes(snap.data().status))
            gate(`This permit is now ${STATUS_LABEL[snap.data().status] || snap.data().status} — it was not extended.`);
          tx.update(ref, { status: "extended", "validity.extendedTo": ne, "validity.openEnded": false, updatedAt: nowISO() });
        });
        closeModal(); toast("Permit extended", "ok"); go("detail", { id });
      } catch (e) { toast(e.message || "Could not extend the permit", "err"); }
    };
  });
  $("#workdone") && ($("#workdone").onclick = () => confirmWorkComplete(p, equip));
  $("#close") && ($("#close").onclick = () => closePermit(p, equip));
  /* ---- trial run ---- */
  const tag = esc(p.equipmentTag || equip?.tag || "the equipment");
  const trialArgs = { isoId: p.isolationRef, permitId: p.id, knownIds: crewIds };
  // Every one of these re-checks its preconditions server-side; the dialog only
  // collects what the signer is attesting to.
  const runTrial = async (fn, args, okMsg, errMsg) => {
    try { await fn({ ...trialArgs, ...args }); } catch (e) { return toast(e.message || errMsg, "err"); }
    closeModal(); toast(okMsg, "ok"); go("detail", { id: p.id });
  };

  $("#trialReq") && ($("#trialReq").onclick = () => {
    modal({ title: "Request a trial run", wide: true, body: `
      <div class="warn-box">A trial run temporarily <b>energises ${tag}</b> to prove your repair. It does not remove the lockout — an Isolator takes the locks out and puts them back.</div>
      <div class="info-box">Every other crew still working under this certificate must clear the trial, then the Issuer must authorise it.</div>
      <label class="lbl">Why is the trial needed?</label>
      <textarea id="trReason" rows="3" placeholder="e.g. run the pump to prove the mechanical seal"></textarea>
      <label class="lbl">How long will it take, in minutes?</label>
      <input id="trMins" type="number" min="1" max="480" placeholder="e.g. 10">
      <div class="help">Everyone can then see when the equipment has been live longer than you expected.</div>
      <label class="checkline"><input type="checkbox" id="trMine"> My own crew is clear of ${tag}</label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>Request trial run</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => {
      const reason = $("#trReason").value.trim();
      if (!reason) return toast("Give a reason for the trial run", "err");
      if (!$("#trMine").checked) return toast("Confirm your own crew is clear", "err");
      runTrial(trialRequest, { reason, expectedMinutes: $("#trMins").value },
        "Trial run requested — waiting on the other crews", "Could not request the trial run");
    };
  });

  $("#trialYes") && ($("#trialYes").onclick = () => {
    modal({ title: "Clear the trial run", wide: true, body: `
      <div class="danger-box"><b>${tag} will be ENERGISED</b> if every crew clears and the Issuer authorises. Confirm your people are clear before you answer.</div>
      <label class="checkline"><input type="checkbox" id="trC1"> All of my crew are clear of the equipment</label>
      <label class="checkline"><input type="checkbox" id="trC2"> My crew has been told a trial run is coming</label>
      <label class="lbl">Remarks (optional)</label><input id="trRem" placeholder="Anything the Issuer should know">`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>My crew is clear</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => {
      if (!($("#trC1").checked && $("#trC2").checked)) return toast("Confirm both checks", "err");
      runTrial(trialAnswer, { decision: "consent", remarks: $("#trRem").value.trim() },
        "Recorded — your crew is clear", "Could not record your answer");
    };
  });

  $("#trialNo") && ($("#trialNo").onclick = () => {
    modal({ title: "Refuse the trial run", body: `
      <div class="info-box">Refusing ends this request. The crew can raise a new one once your work allows it.</div>
      <label class="lbl">Why can your crew not clear?</label>
      <textarea id="trWhy" rows="3" placeholder="e.g. my fitters are inside the guard"></textarea>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>Refuse trial run</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => {
      const remarks = $("#trWhy").value.trim();
      if (!remarks) return toast("Give a reason", "err");
      runTrial(trialAnswer, { decision: "refuse", remarks }, "Trial run refused", "Could not record your refusal");
    };
  });

  $("#trialOk") && ($("#trialOk").onclick = () => {
    const cleared = trialC.given.map((x) => `<span class="mono">${esc(x.permitNo || x.id)}</span>`).join(", ");
    confirmBoxHTML("Authorise trial run",
      `<div class="danger-box">Authorising permits an Isolator to <b>remove the locks and energise ${tag}</b>.</div>
       <div class="info-box">Requested by ${personHTML(isoDoc.trialRun.requestedBy?.name, isoDoc.trialRun.requestedBy)}${isoDoc.trialRun.reason ? ` — ${esc(isoDoc.trialRun.reason)}` : ""}.
       ${cleared ? `Crews cleared: ${cleared}.` : "No other crew is working under this certificate."}</div>
       <p>The equipment stays isolated until an Isolator acts.</p>`,
      "Authorise trial run",
      () => runTrial(trialApprove, {}, "Trial run authorised — an Isolator must now de-isolate", "Could not authorise the trial run"), true);
  });

  $("#trialCancel") && ($("#trialCancel").onclick = () => {
    modal({ title: "Cancel trial run", body: `
      <div class="info-box">The request is withdrawn and kept in the log. Nothing has been energised.</div>
      <label class="lbl">Reason (optional)</label><input id="trCx" placeholder="e.g. no longer needed">`,
      footer: `<button class="btn btn-ghost" data-c>Keep it</button><button class="btn btn-danger" data-ok>Cancel trial run</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => runTrial(trialCancel, { reason: $("#trCx").value.trim() },
      "Trial run cancelled", "Could not cancel the trial run");
  });

  // The Isolator's step. This is the one that actually energises the plant, so
  // the three attestations sit here — with the person taking the locks out.
  $("#trialGo") && ($("#trialGo").onclick = () => {
    const others = onCert.filter((x) => x.id !== isoDoc?.trialRun?.permitId && ["active", "extended"].includes(x.status));
    modal({ title: "De-isolate for trial run", wide: true, body: `
      <div class="danger-box">This removes the locks and <b>ENERGISES ${tag}</b>. Every crew must be clear before you proceed.</div>
      <div class="info-box">Authorised by ${personHTML(isoDoc.trialRun.issuerApproval?.name, isoDoc.trialRun.issuerApproval)} · ${fmt(isoDoc.trialRun.issuerApproval?.at)}${isoDoc.trialRun.reason ? ` — ${esc(isoDoc.trialRun.reason)}` : ""}.
        ${others.length ? `<div style="margin-top:.35rem"><b>${others.length} other permit(s)</b> on this certificate: ${others.map((x) => `<span class="mono">${esc(x.permitNo)}</span>`).join(", ")}.</div>` : ""}</div>
      <label class="checkline"><input type="checkbox" id="tg1"> I have verified every crew is physically clear of the equipment</label>
      <label class="checkline"><input type="checkbox" id="tg2"> All crews on this equipment have been notified</label>
      <label class="checkline"><input type="checkbox" id="tg3"> I am removing the locks and tags for the trial run</label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>Remove locks & energise</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => {
      if (!($("#tg1").checked && $("#tg2").checked && $("#tg3").checked)) return toast("Confirm all three checks", "err");
      runTrial(trialEnergise, {}, "Trial run started — equipment ENERGISED", "Could not energise the equipment");
    };
  });

  $("#trialDone") && ($("#trialDone").onclick = () => {
    modal({ title: "Trial run complete", body: `
      <div class="danger-box"><b>${tag} stays ENERGISED</b> until an Isolator re-applies the locks. Confirming here tells them the trial is finished — it does not make the equipment safe.</div>
      <label class="checkline"><input type="checkbox" id="tdClear"> The trial is finished and my crew is clear of the equipment</label>
      <label class="lbl">Result / remarks (optional)</label><input id="tdRem" placeholder="e.g. seal holding, no leak">`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok>Confirm trial complete</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => {
      if (!$("#tdClear").checked) return toast("Confirm the trial is finished and your crew is clear", "err");
      runTrial(trialComplete, { remarks: $("#tdRem").value.trim() },
        "Recorded — an Isolator has been asked to re-isolate", "Could not record the sign-off");
    };
  });

  $("#reiso") && ($("#reiso").onclick = () => reIsolateDialog(p.equipmentTag || equip?.tag || "The equipment",
    isoDoc?.trialRun, () => runTrial(trialReIsolate, {}, "Re-isolated — work may resume", "Could not re-isolate")));
}

/* -------------------- 6. Permit + isolation logic -------------------- */

// Re-read a permit inside an approval transaction and refuse unless it is still
// awaiting a decision. Two Issuers can open the same permit; without this the
// second one silently overwrites the first one's approval (and its audit stamp).
async function txPermitAwaitingDecision(tx, permitId) {
  const ref = doc(db, "permits", permitId);
  const snap = await tx.get(ref);
  if (!snap.exists()) gate("This permit no longer exists.");
  const cur = snap.data();
  if (cur.status !== "submitted")
    gate(`This permit is now ${STATUS_LABEL[cur.status] || cur.status} — it was not approved again. Reopen it to see the current state.`);
  return { ref, cur };
}
// Re-read the equipment inside an approval transaction and refuse unless its
// certificate pointer is still what the dialog was drawn from. This is what
// makes a stale page safe: the whole certificate branch below is chosen from
// `equip.activeIsolationId`, which may be minutes old by the time Approve is
// clicked. `expected` is the certificate id the branch assumed, or null for
// "there was no certificate".
async function txEquipmentPointer(tx, equipmentId, expected) {
  const ref = doc(db, "equipment", equipmentId);
  const snap = await tx.get(ref);
  if (!snap.exists()) gate("This equipment record no longer exists.");
  const actual = snap.data().activeIsolationId || null;
  if (actual !== (expected || null)) {
    gate(actual
      ? "This equipment is now under a different isolation certificate than when this page was loaded. Reopen the permit and review before approving."
      : "This equipment's isolation was removed while this page was open. Reopen the permit and review before approving.");
  }
  return { ref, data: snap.data() };
}

/* Writing an auto-rejection down. Everything that gates on it is derived, so
   this exists purely so the record still says what happened when somebody reads
   the permit years later — and so the register can be queried on stored status.

   It runs when an Issuer or Admin OPENS such a permit, because a static site has
   nowhere else to run it. Restricted to those two roles for two reasons: the
   rules already grant them full authority over a permit (so no rule has to be
   loosened for a "system" writer that could then be impersonated), and they are
   the only people whose device clock deciding this is defensible.

   The whole thing is re-derived inside the transaction from server state. A
   permit approved thirty seconds ago on another phone must not be stamped by a
   page that was drawn before that landed. */
async function stampAutoReject(p, isoDoc) {
  const pol = autoRejectPolicy();
  try {
    // Returns true only when something was actually written. The repaint below
    // is conditional on it: repainting after a no-op would redraw a page whose
    // state has not changed, which for a still-lapsed permit means stamping,
    // repainting, stamping… — a loop.
    const wrote = await lifecycleTx("auto-rejection", async (tx) => {
      const pRef = doc(db, "permits", p.id);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists()) return false;
      const cur = { id: p.id, ...pSnap.data() };
      if (!["submitted", "awaitingIsolation"].includes(cur.status)) return false;   // decided meanwhile
      const isoRef = cur.isolationRef ? doc(db, "isolations", cur.isolationRef) : null;
      const iSnap = isoRef ? await tx.get(isoRef) : null;
      const iso = iSnap && iSnap.exists() ? { id: cur.isolationRef, ...iSnap.data() } : null;
      // Re-derived against what the server actually holds, not what the page drew.
      const st = autoRejectState(cur, iso ? [iso] : [], pol);
      if (st?.phase !== "lapsed") return false;
      // Read before any write — a transaction may not read after it has written.
      const eqRef = cur.equipmentRef ? doc(db, "equipment", cur.equipmentRef) : null;
      const eqSnap = eqRef && iso ? await tx.get(eqRef) : null;
      tx.update(pRef, {
        status: "expired",
        autoReject: { at: new Date(st.at).toISOString(), rule: st.rule, hours: st.rule === "idle" ? (cur.status === "submitted" ? pol.submittedHours : pol.awaitingIsolationHours) : null,
          stampedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() }, stampedAt: nowISO() },
        updatedAt: nowISO()
      });
      // The certificate, if any. autoRejectSafe() has already established that it
      // is `assigned` and carries no other crew — i.e. the locks were never
      // applied — so this is the identical branch a manual rejection takes, and
      // the ONLY branch automation is ever allowed to reach.
      if (iso && iso.status === "assigned") {
        tx.update(isoRef, { attachedPermitIds: [], status: "removed", removedAt: nowISO(),
          removalConfirmedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() },
          removalNote: "Cancelled — permit auto-rejected before isolation" });
        if (eqSnap && eqSnap.exists() && eqSnap.data().activeIsolationId === cur.isolationRef)
          tx.update(eqRef, { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
      }
      return true;
    });
    if (wrote && $("#pd")) go("detail", { id: p.id });
  } catch { /* Derivation stays in charge — offline, or somebody got there first. */ }
}

// Putting one back. Offered to an Issuer for a short window after the stamp, for
// the case the deadline was simply wrong (a shutdown slipped, the plant was on
// holiday). It restarts BOTH clocks honestly — a new planned end and a fresh
// submission stamp — rather than granting an exemption, so the permit is subject
// to the same rule again. Any certificate was cancelled by the stamp, so this
// returns the permit to `submitted`: it must be approved afresh, which is what
// mints a new certificate.
function reinstatePermit(p) {
  const dflt = new Date(Date.now() + 24 * 3600000);
  dflt.setMinutes(dflt.getMinutes() - dflt.getTimezoneOffset());
  modal({ title: "Reinstate permit", body: `<div class="info-box">This permit auto-rejected. Reinstating puts it back in the approval queue with a new planned end — it is not an approval, and the same auto-rejection rule applies again.</div>
    <label class="field"><span>New planned end</span><input type="datetime-local" id="rsEnd" value="${esc(dflt.toISOString().slice(0, 16))}"></label>
    <label class="checkline"><input type="checkbox" id="rsOpen"> Open-ended (valid while active)</label>
    <label class="field"><span>Reason</span><textarea id="rsWhy" placeholder="Why is this being put back?"></textarea></label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok>Reinstate</button>` });
  $("[data-c]").onclick = closeModal;
  $("#rsOpen").onchange = () => { $("#rsEnd").disabled = $("#rsOpen").checked; };
  $("[data-ok]").onclick = async () => {
    const open = $("#rsOpen").checked, end = $("#rsEnd").value;
    if (!open && !end) return toast("Set a new planned end, or tick open-ended.", "err");
    if (!open && new Date(end) <= new Date()) return toast("The new planned end must be in the future.", "err");
    const why = $("#rsWhy").value.trim();
    try {
      await lifecycleTx("reinstatement", async (tx) => {
        const ref = doc(db, "permits", p.id);
        const snap = await tx.get(ref);
        if (!snap.exists()) gate("This permit no longer exists.");
        const cur = snap.data();
        if (cur.status !== "expired")
          gate(`This permit is now ${STATUS_LABEL[cur.status] || cur.status} — it was not reinstated.`);
        tx.update(ref, {
          status: "submitted",
          // The stamp cancelled the certificate; a reinstated permit must not
          // keep pointing at a dead one, or it would look attached to a lockout
          // that no longer exists.
          isolationRef: null, isoNo: null,
          "validity.openEnded": open, "validity.plannedEnd": open ? null : new Date(end).toISOString(), "validity.extendedTo": null,
          submittedAt: nowISO(),
          autoReject: { ...(cur.autoReject || {}), reinstatedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() }, reinstatedAt: nowISO(), reinstateReason: why || null },
          updatedAt: nowISO()
        });
      });
      closeModal(); toast("Permit reinstated — back in the approval queue", "ok");
      go("detail", { id: p.id }); refreshPendingBadge();
    } catch (e) { toast(e.message || "Could not reinstate the permit", "err"); }
  };
}

async function approvePermit(p, equip) {
  const type = State.config.permitTypes.find((t) => t.code === p.type);
  const approval = () => ({ issuerUid: State.profile.id, issuerName: State.profile.name, ...myMeta(), timestamp: nowISO() });

  // AVAILABILITY GATE (authoritative — the picker/submission checks are only
  // early feedback): equipment whose work cycle is in hand-back, or carrying
  // permits awaiting closure, cannot receive new work until all are closed.
  // Read fresh from the server, never from the cached copy: this condition
  // spans the whole permit collection, so unlike the permit status and the
  // certificate pointer it cannot be re-checked inside the approval
  // transaction. This read is the only place it is enforced.
  const [allPermits, allIsos] = await Promise.all([fetchPermits({ fresh: true }), fetchIsolations({ fresh: true }).catch(() => [])]);
  // AUTO-REJECTION GATE, re-derived against the same fresh read. The Approve
  // button is already hidden on a lapsed permit, but a page left open on a desk
  // crosses the deadline without being redrawn, and hiding a button has never
  // been a control. Checked here so the approval dialog cannot even open.
  const arNow = autoRejectState({ ...p, ...(allPermits.find((x) => x.id === p.id) || {}) }, allIsos, autoRejectPolicy());
  if (arNow?.phase === "lapsed") {
    return confirmBoxHTML("Cannot approve — permit auto-rejected",
      `<div class="danger-box"><b>${esc(p.permitNo)} was auto-rejected — ${esc(AUTO_REJECT_RULE[arNow.rule])}.</b></div>
       <p>It cannot be approved. Reinstate it with a new planned end, or ask the requester to raise a new permit with current dates${State.config.permitTypes.find((t) => t.code === p.type)?.requiresGasTest ? " and a fresh gas test" : ""}.</p>`,
      "OK", async () => closeModal());
  }
  const block = equipmentBlock(p.equipmentRef, allPermits, allIsos, p.id, autoRejectPolicy());
  if (block) {
    return confirmBoxHTML("Cannot approve — equipment not available",
      blockBox(p.equipmentTag, block, allIsos) + `<p>Close the earlier permit(s) before approving new work on this equipment.</p>`,
      "OK", async () => closeModal());
  }
  // Concurrent-work cross-check, shown to the Issuer in every approval dialog
  // (previously only non-isolation permits got it): each live permit with its
  // hand-back stage, overdue flagged. Warning only — the Issuer decides.
  const others = allPermits.filter((x) => x.id !== p.id && x.equipmentRef === p.equipmentRef &&
    ["submitted", "awaitingIsolation", "active", "extended"].includes(x.status) && !isAutoRejected(x, allIsos, autoRejectPolicy()));
  const concurrentWarn = others.length ? `<div class="warn-box"><b>${others.length} other live permit(s)</b> already on ${esc(p.equipmentTag)}. Review concurrent work.
    <div class="attached-list" style="margin-top:.5rem">${others.map((x) => `<div class="a"><span class="mono">${esc(x.permitNo)}</span> ${esc(x.typeName)} · ${esc(x.requester?.name || "")} ${badge(x.status)}${stageChip(permitStage(x, allIsos))}${isOverdue(x) ? " " + overdueChip() : ""}</div>`).join("")}</div></div>` : "";

  // --- non-isolation permits: approve straight to Active ---
  if (!type.requiresIsolation) {
    // Safety cross-check: warn the Issuer if the equipment is currently isolated
    // / energised for a trial, or already carries other live permits.
    let warn = concurrentWarn;
    const eqStatus = equip?.isolationStatus;
    if (eqStatus === "isolated" || eqStatus === "pending") warn += `<div class="warn-box">${esc(equip.tag)} is currently under an <b>isolation (LOTO)</b> for other work. Confirm this work is compatible before activating.</div>`;
    if (eqStatus === "trialRun") warn += `<div class="danger-box"><b>${esc(equip.tag)} is ENERGISED for a trial run.</b> Do not activate work that needs it de-energised.</div>`;
    confirmBoxHTML("Approve permit", `${warn}<p>Approve <b>${esc(p.permitNo)}</b> and activate the work?</p>`, "Approve & activate", async () => {
      // No pointer check here on purpose: a non-isolation permit may be approved
      // onto isolated or trial-run equipment — that is a warning for the Issuer
      // to weigh (above), not a block. Only the double-approval race is closed.
      await lifecycleTx("approval", async (tx) => {
        const { ref } = await txPermitAwaitingDecision(tx, p.id);
        tx.update(ref, { status: "active", approval: approval(), updatedAt: nowISO() });
      });
      closeModal(); toast("Permit approved & activated", "ok"); go("detail", { id: p.id }); refreshPendingBadge();
    });
    return;
  }

  // --- isolation permits: certificate chain ---
  let iso = null;
  if (equip?.activeIsolationId) {
    const s = await getDoc(doc(db, "isolations", equip.activeIsolationId));
    if (s.exists()) iso = { id: s.id, ...s.data() };
  }

  // SAFETY GATE: never attach a new crew's permit to an isolation while the
  // equipment is ENERGISED for a trial run. Approving it "Active" would send
  // a crew onto live equipment. Re-isolate first, then approve.
  if (iso && iso.status === "trialRun") {
    return confirmBoxHTML("Cannot approve — trial run in progress",
      `<div class="danger-box"><b>${esc(equip.tag)} is ENERGISED for a trial run</b> under certificate <b class="mono">${esc(iso.isoNo || "")}</b>. This permit cannot be attached or activated until the equipment is re-isolated.</div>`,
      "OK", async () => closeModal());
  }

  // SAFETY GATE: the certificate is mid de-isolation — locks are coming OFF.
  // Attaching new work now, or spawning a second certificate that would
  // overwrite the equipment's pointer to this one, could put a crew on live
  // equipment. (The availability gate above catches this too, but only while
  // permits still reference the certificate — this covers it via the equipment.)
  if (iso && iso.status === "removalPending") {
    return confirmBoxHTML("Cannot approve — de-isolation in progress",
      `<div class="danger-box"><b>${esc(equip.tag)} is being de-isolated</b> under certificate <b class="mono">${esc(iso.isoNo || "")}</b>. Wait until de-isolation is complete and the earlier permits are closed — a fresh certificate will then be created on approval.</div>`,
      "OK", async () => closeModal());
  }

  if (iso && iso.status === "active") {
    // shared isolation already confirmed → attach, permit goes Active. If some
    // crews on the lockout have already signed off, tell the Issuer plainly
    // that approving keeps the isolation in place for the new work.
    const signedOff = allPermits.filter((x) => x.isolationRef === iso.id && ["active", "extended"].includes(x.status) && x.workCompletion).length;
    confirmBoxHTML("Approve permit",
      `${concurrentWarn}
       ${signedOff ? `<div class="warn-box"><b>${signedOff} crew(s) on this lockout have already signed off work-complete.</b> Approving attaches new work to the certificate and keeps the isolation in place — de-isolation will now also wait for this permit.</div>` : ""}
       <div class="info-box">${esc(equip.tag)} is already isolated under certificate <b class="mono">${esc(iso.isoNo || "")}</b>. This permit will <b>attach to the shared isolation</b> and become Active immediately.</div>
       <p>Approve <b>${esc(p.permitNo)}</b>?</p>`, "Approve & attach", async () => {
      await lifecycleTx("approval", async (tx) => {
        const { ref: pRef } = await txPermitAwaitingDecision(tx, p.id);
        await txEquipmentPointer(tx, equip.id, iso.id);
        const isoRef = doc(db, "isolations", iso.id);
        const iSnap = await tx.get(isoRef);
        if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
        // Attaching a crew to a lockout is only safe while the locks are on and
        // staying on. If it has since gone to trial run or de-isolation, refuse.
        if (iSnap.data().status !== "active")
          gate(`This certificate is now ${STATUS_LABEL[iSnap.data().status] || iSnap.data().status} — the permit was not attached. Reopen it and review.`);
        tx.update(isoRef, { attachedPermitIds: arrayUnion(p.id) });
        tx.update(pRef, { status: "active", isolationRef: iso.id, isoNo: iso.isoNo || null, approval: approval(), updatedAt: nowISO() });
      });
      closeModal(); toast("Permit approved & attached to isolation", "ok"); go("detail", { id: p.id }); refreshPendingBadge();
    });
    return;
  }

  if (iso && iso.status === "assigned") {
    // isolation assigned but not yet confirmed → attach, permit waits
    confirmBoxHTML("Approve permit",
      `${concurrentWarn}
       <div class="warn-box">Isolation certificate <b class="mono">${esc(iso.isoNo || "")}</b> for ${esc(equip.tag)} is assigned to <b>${esc(iso.assignedTo?.name || "")}</b> and awaiting confirmation. This permit will attach to it and activate automatically once the isolation is confirmed.</div>
       <p>Approve <b>${esc(p.permitNo)}</b>?</p>`, "Approve & attach", async () => {
      await lifecycleTx("approval", async (tx) => {
        const { ref: pRef } = await txPermitAwaitingDecision(tx, p.id);
        await txEquipmentPointer(tx, equip.id, iso.id);
        const isoRef = doc(db, "isolations", iso.id);
        const iSnap = await tx.get(isoRef);
        if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
        const st = iSnap.data().status;
        // The certificate may have been confirmed while this dialog was open. It
        // is still safe to attach, but the permit must then go straight to Active
        // rather than waiting for a confirmation that has already happened.
        if (st !== "assigned" && st !== "active")
          gate(`This certificate is now ${STATUS_LABEL[st] || st} — the permit was not attached. Reopen it and review.`);
        tx.update(isoRef, { attachedPermitIds: arrayUnion(p.id) });
        tx.update(pRef, { status: st === "active" ? "active" : "awaitingIsolation", isolationRef: iso.id, isoNo: iso.isoNo || null, approval: approval(), updatedAt: nowISO() });
      });
      closeModal(); toast("Approved — awaiting isolation confirmation"); go("detail", { id: p.id }); refreshPendingBadge();
    });
    return;
  }

  // no usable isolation → create a new certificate and assign it.
  // A certificate is anchored to an equipment record (the isolation status and
  // the pointer both live there), so without one there is nothing to isolate —
  // the old code would have thrown a TypeError on equip.id here.
  if (!equip) return toast("This permit's equipment record is missing, so an isolation certificate cannot be created. Ask an Admin to restore it.", "err");
  const users = await isolatorUsers();
  if (!users.length) return toast("No active Isolator users found. Ask an Admin to assign the Isolator role to a user first.", "err");
  modal({ title: "Approve & create isolation certificate", wide: true, body: `
    ${concurrentWarn}
    <div class="info-box">A new <b>isolation certificate</b> with its own reference number will be created for <b>${esc(equip?.tag || "")}</b>. The permit stays <b>Awaiting Isolation</b> until the assigned person confirms in the app that the isolation is physically applied.</div>
    <div class="section-title">Isolation points (from the permit)</div>
    ${(p.isolationPoints || []).map((i) => `<div class="checkline">• ${esc(i.point)}${i.method ? " — " + esc(i.method) : ""}${i.lockTag ? " · " + esc(i.lockTag) : ""}</div>`).join("") || "<div class='help'>No points listed — they can be completed at confirmation.</div>"}
    <label class="field" style="margin-top:.8rem"><span>Assign isolation to <span class="req">*</span></span>
      <select id="assignTo">${users.map((u) => `<option value="${u.id}">${esc(u.name)}${(u.jobTitle || u.position) ? " — " + esc(u.jobTitle || u.position) : ""}</option>`).join("")}</select></label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Approve & assign isolation</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => {
    const au = users.find((u) => u.id === $("#assignTo").value);
    const isoId = uid(); const isoNo = makeIsoNo();
    try {
      // THE critical transaction. This branch is reached because the equipment
      // had no certificate *when this page loaded* — which may be minutes old.
      // Writing blind here is how a second certificate gets created on equipment
      // that already has a live one: the pointer below is overwritten, the first
      // certificate is orphaned, and when the second is de-isolated the equipment
      // reads Available while a crew is still under the first one's locks.
      // Re-reading the pointer inside the transaction makes that impossible —
      // if anything claimed the equipment meanwhile, this aborts instead.
      await lifecycleTx("approval", async (tx) => {
        const { ref: pRef } = await txPermitAwaitingDecision(tx, p.id);
        const { ref: eqRef } = await txEquipmentPointer(tx, equip.id, null);
        tx.set(doc(db, "isolations", isoId), {
          isoNo, equipmentRef: equip.id, equipmentTag: equip.tag,
          points: p.isolationPoints || [], status: "assigned",
          assignedTo: { uid: au?.id || null, name: au?.name || "", ...userMeta(au) }, assignedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() }, assignedAt: nowISO(),
          confirmedBy: null, confirmedAt: null,
          removalAssignedTo: null, removalAssignedAt: null, removalConfirmedBy: null, removedAt: null,
          attachedPermitIds: [p.id], createdBy: State.profile.name, createdByMeta: myMeta(), createdAt: nowISO()
        });
        tx.update(eqRef, { isolationStatus: "pending", activeIsolationId: isoId, updatedAt: nowISO() });
        tx.update(pRef, { status: "awaitingIsolation", isolationRef: isoId, isoNo, approval: approval(), updatedAt: nowISO() });
      });
    } catch (e) { return toast(e.message || "Could not approve the permit", "err"); }
    closeModal(); toast(`Certificate ${isoNo} assigned to ${au?.name || ""}`, "ok"); go("detail", { id: p.id }); refreshPendingBadge();
  };
}

// Requester's written sign-off that the job is finished and the equipment is
// safe to return to service. The permit cannot be closed until this is on record.
async function confirmWorkComplete(p, equip) {
  const isolated = !!p.isolationRef;
  modal({ title: "Confirm work complete", wide: true, body: `
    <div class="info-box">Confirm the work under permit <b class="mono">${esc(p.permitNo)}</b> on <b>${esc(p.equipmentTag || "")}</b> is finished and the equipment is safe to return to service.${isolated ? " An Isolator will then de-isolate the equipment, after which the Issuer can close the permit." : " The Issuer can then close the permit."}</div>
    <label class="field"><span>Completion remarks <span class="req">*</span></span><textarea id="wcRemarks" placeholder="Work completed, tools and personnel removed, area cleared…"></textarea></label>
    <label class="checkline"><input type="checkbox" id="wcAck"> I confirm the work is complete and <b>${esc(p.equipmentTag || "the equipment")}</b> is safe to return to service.</label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Confirm work complete</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => {
    const remarks = $("#wcRemarks").value.trim();
    if (!remarks) return toast("Enter completion remarks", "err");
    if (!$("#wcAck").checked) return toast("Tick the confirmation statement", "err");
    try {
      await lifecycleTx("work completion", async (tx) => {
        const ref = doc(db, "permits", p.id);
        const snap = await tx.get(ref);
        if (!snap.exists()) gate("This permit no longer exists.");
        const cur = snap.data();
        // Re-checked server-side: the permit may have been closed or rejected
        // while this dialog was open, and work-complete must not resurrect it.
        if (!["active", "extended"].includes(cur.status))
          gate(`This permit is now ${STATUS_LABEL[cur.status] || cur.status} — work completion was not recorded.`);
        if (cur.workCompletion) gate("Work completion has already been recorded for this permit.");
        tx.update(ref, {
          workCompletion: { by: State.profile.id, name: State.profile.name, ...myMeta(), remarks, safeToReturn: true, timestamp: nowISO() },
          updatedAt: nowISO()
        });
      });
      closeModal(); toast(isolated ? "Work complete — equipment can now be de-isolated" : "Work complete — Issuer can now close the permit", "ok"); go("detail", { id: p.id });
    } catch (e) { toast(e.message || "Could not confirm work completion", "err"); }
  };
}

async function closePermit(p, equip) {
  // Hand-back gates: requester signs off work → Isolator de-isolates → Issuer
  // closes. The de-isolation now happens on the certificate before this point,
  // so closing is a clean final step (no inline lock removal here).
  if (!p.workCompletion) return toast("The requester must confirm the work is complete before this permit can be closed.", "err");
  let iso = null;
  if (p.isolationRef) {
    const s = await getDoc(doc(db, "isolations", p.isolationRef));
    if (s.exists()) iso = { id: s.id, ...s.data() };
  }
  if (iso && iso.status === "trialRun") return toast("Re-isolate after the trial run before closing", "err");
  if (iso && iso.status !== "removed") return toast("An Isolator must de-isolate the equipment before this permit can be closed.", "err");

  confirmBoxHTML("Close permit",
    `<div class="info-box">Work is complete${iso ? " and <b>" + esc(p.equipmentTag || "the equipment") + "</b> has been de-isolated and returned to service" : ""}. Closing finalises permit <b class="mono">${esc(p.permitNo)}</b>.</div>
     <label class="field"><span>Closure remarks</span><textarea id="crem" placeholder="Work complete, area cleared…"></textarea></label>`,
    "Close permit", async () => {
      const remarks = $("#crem")?.value.trim() || "";
      await lifecycleTx("closure", async (tx) => {
        const pRef = doc(db, "permits", p.id);
        const pSnap = await tx.get(pRef);
        if (!pSnap.exists()) gate("This permit no longer exists.");
        const cur = pSnap.data();
        if (!["active", "extended"].includes(cur.status))
          gate(`This permit is now ${STATUS_LABEL[cur.status] || cur.status} — it was not closed again.`);
        if (!cur.workCompletion) gate("The requester must confirm the work is complete before this permit can be closed.");
        // The de-isolation gates above were checked before the dialog opened;
        // re-check them here against the live certificate so a lockout that is
        // still on (or back on for a trial) cannot be closed out from under.
        if (cur.isolationRef) {
          const iSnap = await tx.get(doc(db, "isolations", cur.isolationRef));
          const st = iSnap.exists() ? iSnap.data().status : null;
          if (st === "trialRun") gate("Re-isolate after the trial run before closing.");
          if (st && st !== "removed") gate("An Isolator must de-isolate the equipment before this permit can be closed.");
        }
        tx.update(pRef, { status: "closed", closure: { by: State.profile.id, name: State.profile.name, ...myMeta(), remarks, timestamp: nowISO() }, updatedAt: nowISO() });
      });
      closeModal(); toast("Permit closed", "ok"); go("detail", { id: p.id });
    });
}

/* ---------- Trial run: the six lifecycle writes ----------
   Request → consent → Issuer authorisation → Isolator de-isolates → ENERGISED
   → Isolator re-isolates. Each step is a `tx`-taking core plus a thin
   lifecycleTx wrapper, so the cores can be exercised against a simulated
   transaction (tests/trial-run-tx.mjs) rather than only in a browser.

   Two rules hold across all six:
     - every precondition is re-read INSIDE the transaction. Nothing is decided
       from the loaded page, because the page can be minutes old and the thing
       being decided is whether crews are standing next to live equipment.
     - the signed-in user is passed in as `actor`, never read from State by the
       core, so the role checks are testable and cannot drift from the UI.

   Not yet wired to any button — the UI arrives in the next piece. */

// Who is signing. Carries the role so the transaction can enforce the same
// separation the UI shows, and so the audit trail records the authority the
// signer held at the time.
function actorStamp() {
  const p = State.profile || {};
  return { uid: p.id, name: p.name, role: p.role, ...myMeta() };
}

// Every permit that might be a crew on this certificate, re-read inside the
// transaction. `attachedPermitIds` is the certificate's own list, but it can be
// emptied while permits still point at the certificate (rejecting the last
// permit on a confirmed lockout does exactly that), so the caller's page list is
// unioned in and each candidate is re-checked against its own isolationRef.
async function txReadCrew(tx, isoId, isoData, knownIds) {
  const ids = [...new Set([...(isoData.attachedPermitIds || []), ...(knownIds || [])])].filter(Boolean);
  const snaps = await Promise.all(ids.map((pid) => tx.get(doc(db, "permits", pid))));
  return snaps.filter((s) => s.exists()).map((s) => ({ id: s.id, ...s.data() }))
    .filter((p) => p.isolationRef === isoId);
}

// 1. The crew doing the work asks. Not the Issuer, not an Admin — the trial is
//    requested by the people who need it to prove their repair.
async function txTrialRequest(tx, o) {
  const pRef = doc(db, "permits", o.permitId);
  const isoRef = doc(db, "isolations", o.isoId);
  const [pSnap, iSnap] = await Promise.all([tx.get(pRef), tx.get(isoRef)]);
  if (!pSnap.exists()) gate("This permit no longer exists.");
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const p = pSnap.data(), iso = { id: o.isoId, ...iSnap.data() };
  if (!["active", "extended"].includes(p.status))
    gate(`This permit is now ${STATUS_LABEL[p.status] || p.status} — no trial run was requested.`);
  if (p.isolationRef !== o.isoId)
    gate("This permit is no longer attached to that isolation certificate.");
  if (p.requester?.uid !== o.actor.uid)
    gate("Only the permit's own requester may ask for a trial run.");
  if (iso.status !== "active")
    gate(`The isolation is now ${STATUS_LABEL[iso.status] || iso.status} — no trial run was requested.`);
  if (iso.trialRun) gate("A trial run is already in progress on this certificate.");
  tx.update(isoRef, {
    trialRun: {
      status: "requested", permitId: o.permitId, permitNo: p.permitNo || null,
      reason: o.reason || "", expectedMinutes: Number(o.expectedMinutes) > 0 ? Math.min(Math.round(Number(o.expectedMinutes)), TRIAL_MAX_MINUTES) : null,
      requestedBy: o.actor, requestedAt: o.at,
      // The requester's own entry records who asked. trialConsentState never
      // counts it as an answer — it can only ever speak for this one crew.
      consents: [{ permitId: o.permitId, permitNo: p.permitNo || null, ...o.actor,
                   decision: "requested", at: o.at, remarks: o.reason || "" }],
      issuerApproval: null, deisolatedBy: null, deisolatedAt: null,
      reIsolatedBy: null, reIsolatedAt: null
    }
  });
}

// 2. Every other crew still on the tools clears — or refuses, which kills the
//    request outright. One "no" is enough; nobody overrules a crew on this.
async function txTrialAnswer(tx, o) {
  if (!["consent", "refuse"].includes(o.decision)) gate("Unrecognised answer — nothing was recorded.");
  const isoRef = doc(db, "isolations", o.isoId);
  const iSnap = await tx.get(isoRef);
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const iso = { id: o.isoId, ...iSnap.data() };
  if (trialStage(iso) !== "requested")
    gate(iso.trialRun
      ? "This trial run has already been decided — your answer was not recorded."
      : "There is no trial run request on this certificate.");
  const crew = await txReadCrew(tx, o.isoId, iso, o.knownIds);
  const mine = trialConsentTargets(iso, crew, iso.trialRun.permitId).find((p) => p.id === o.permitId);
  if (!mine) gate("Your permit is not one of the crews being asked to clear this trial run.");
  if (mine.requester?.uid !== o.actor.uid) gate("Only the permit's own requester may answer for that crew.");
  if ((iso.trialRun.consents || []).some((c) => c && c.permitId === o.permitId &&
      (c.decision === "consent" || c.decision === "refuse")))
    gate("Your crew has already answered this trial run request.");
  const entry = { permitId: o.permitId, permitNo: mine.permitNo || null, ...o.actor,
                  decision: o.decision, at: o.at, remarks: o.remarks || "" };
  if (o.decision === "consent") {
    // An explicit array appended at the end, not arrayUnion: security rules
    // cannot inspect the result of an array transform, and the rule for this
    // write has to see that exactly one entry was added, that it names a
    // permit this user owns, and that no earlier answer was altered. The
    // surrounding transaction is what makes read-modify-write safe here — two
    // crews clearing at the same moment cannot lose an answer, because the
    // second transaction re-reads and retries.
    tx.update(isoRef, { "trialRun.consents": [...(iso.trialRun.consents || []), entry] });
    return;
  }
  tx.update(isoRef, {
    trialRun: null,
    trialRunLog: [...(iso.trialRunLog || []), { ...iso.trialRun,
      consents: [...(iso.trialRun.consents || []), entry],
      status: "closed", outcome: "refused", closedBy: o.actor, closedAt: o.at }]
  });
}

// 3. The Issuer authorises. This is authority to energise, not the act of it —
//    the locks stay on until an Isolator pulls them at step 5.
async function txTrialApprove(tx, o) {
  const isoRef = doc(db, "isolations", o.isoId);
  const iSnap = await tx.get(isoRef);
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const iso = { id: o.isoId, ...iSnap.data() };
  if (!["issuer", "admin"].includes(o.actor.role)) gate("Only an Issuer may authorise a trial run.");
  if (trialStage(iso) !== "requested")
    gate(trialStage(iso) ? "This trial run has already been authorised." : "There is no trial run request on this certificate.");
  if (iso.status !== "active")
    gate(`The isolation is now ${STATUS_LABEL[iso.status] || iso.status} — the trial run was not authorised.`);
  const crew = await txReadCrew(tx, o.isoId, iso, o.knownIds);
  const st = trialConsentState(iso, crew);
  if (st.refused.length)
    gate(`${st.refused[0].permitNo || "A crew"} has refused this trial run — it cannot be authorised.`);
  if (st.outstanding.length)
    gate(`${st.outstanding.length} crew(s) have not cleared yet (${st.outstanding.map((p) => p.permitNo || p.id).join(", ")}) — the trial run was not authorised.`);
  tx.update(isoRef, { "trialRun.status": "approved", "trialRun.issuerApproval": { ...o.actor, at: o.at } });
}

// 4. Called off before the locks came out. Once ENERGISED there is no cancel —
//    the only way back is an Isolator re-isolating at step 6.
async function txTrialCancel(tx, o) {
  const isoRef = doc(db, "isolations", o.isoId);
  const iSnap = await tx.get(isoRef);
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const iso = { id: o.isoId, ...iSnap.data() };
  const stage = trialStage(iso);
  if (stage === "energised") gate("The equipment is energised — it must be re-isolated, not cancelled.");
  // Deliberately keyed on the record EXISTING rather than on a recognised
  // stage. A trialRun object this build does not understand — written by a
  // newer version while this client ran from the service-worker cache, or by a
  // partial write — must still be clearable, or the certificate deadlocks:
  // every other step refuses it and no trial run can ever run here again.
  if (!iso.trialRun) gate("There is no trial run request to cancel.");
  if (iso.trialRun.requestedBy?.uid !== o.actor.uid && !["issuer", "admin"].includes(o.actor.role))
    gate("Only the crew that asked, or an Issuer, may cancel a trial run request.");
  tx.update(isoRef, {
    trialRun: null,
    trialRunLog: [...(iso.trialRunLog || []), { ...iso.trialRun, status: "closed", outcome: "cancelled",
      closedBy: o.actor, closedAt: o.at, closeReason: o.reason || "" }]
  });
}

// 5. THE step that puts live power on equipment crews are holding permits on.
//    Readiness is recomputed here from the permits this transaction read
//    itself: a crew attached to the lockout after the consents were gathered
//    never cleared, so the trial stops rather than energising around them.
async function txTrialEnergise(tx, o) {
  const isoRef = doc(db, "isolations", o.isoId);
  const iSnap = await tx.get(isoRef);
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const iso = { id: o.isoId, ...iSnap.data() };
  if (!["isolator", "admin"].includes(o.actor.role))
    gate("Only an Isolator may remove the locks for a trial run.");
  const stage = trialStage(iso);
  if (stage === "energised") gate("This trial run is already in progress — the equipment is energised.");
  if (stage !== "approved")
    gate(stage === "requested"
      ? "The Issuer has not authorised this trial run yet — the equipment was not energised."
      : "There is no authorised trial run on this certificate.");
  const crew = await txReadCrew(tx, o.isoId, iso, o.knownIds);
  // The certificate names the equipment it locks out, so trust that over
  // anything the caller passed, and refuse when it cannot be resolved at all.
  // Energising without writing the equipment record would flip the certificate
  // live while the asset register still read "Isolated".
  const eqId = iso.equipmentRef || o.equipmentId || null;
  const eqRef = eqId ? doc(db, "equipment", eqId) : null;
  const eqSnap = eqRef ? await tx.get(eqRef) : null;          // last read before any write
  if (!eqRef) gate("This certificate does not name the equipment it isolates — the equipment was not energised.");
  if (!trialReadyToEnergise(iso, crew)) {
    const st = trialConsentState(iso, crew);
    if (st.refused.length) gate("A crew has refused this trial run — the equipment was not energised.");
    if (st.outstanding.length)
      gate(`${st.outstanding.length} crew(s) on this lockout have not cleared the trial run (${st.outstanding.map((p) => p.permitNo || p.id).join(", ")}) — the equipment was not energised.`);
    gate(`The isolation is now ${STATUS_LABEL[iso.status] || iso.status} — the equipment was not energised.`);
  }
  if (eqSnap && !eqSnap.exists()) gate("This equipment record no longer exists.");
  if (eqSnap && (eqSnap.data().activeIsolationId || null) !== o.isoId)
    gate("This equipment is now under a different isolation certificate — the equipment was not energised.");
  tx.update(isoRef, { status: "trialRun", "trialRun.status": "energised",
    "trialRun.deisolatedBy": o.actor, "trialRun.deisolatedAt": o.at });
  if (eqRef) tx.update(eqRef, { isolationStatus: "trialRun", updatedAt: o.at });
}

// 5b. The crew says the trial has served its purpose and the equipment can be
//     locked out again. This is a SIGNAL, not a state change: the equipment
//     stays energised until an Isolator physically re-applies the locks, and an
//     Isolator may always re-isolate without waiting for it. Without this the
//     Isolator has no way to know the trial is finished except by asking.
async function txTrialComplete(tx, o) {
  const isoRef = doc(db, "isolations", o.isoId);
  const iSnap = await tx.get(isoRef);
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const iso = { id: o.isoId, ...iSnap.data() };
  if (trialStage(iso) !== "energised")
    gate(isTrialEnergised(iso)
      ? "This trial run was started by the earlier flow and cannot be signed off here — an Isolator can re-isolate directly."
      : "The equipment is not energised for a trial run.");
  if (iso.trialRun.completedBy) gate("The end of this trial run has already been confirmed.");
  // The crew that asked is the one that knows whether the trial proved what it
  // needed to. An Issuer may also close it out, so a shift change cannot leave
  // the equipment energised with nobody able to say it is finished.
  const pSnap = await tx.get(doc(db, "permits", iso.trialRun.permitId));
  const asker = pSnap.exists() ? pSnap.data().requester?.uid : null;
  if (asker !== o.actor.uid && !["issuer", "admin"].includes(o.actor.role))
    gate("Only the crew that asked for the trial run, or an Issuer, may confirm it is finished.");
  tx.update(isoRef, { "trialRun.completedBy": o.actor, "trialRun.completedAt": o.at,
    "trialRun.completionRemarks": o.remarks || "" });
}

// 6. Locks back on, work may resume. Accepts a certificate energised by the
//    FIRST version of this feature too (status trialRun, no sub-document, the
//    record stranded on one permit) — those must not be left un-re-isolatable,
//    and their permit-side entries are closed here so the log stops claiming
//    the equipment is still live.
async function txTrialReIsolate(tx, o) {
  const isoRef = doc(db, "isolations", o.isoId);
  const iSnap = await tx.get(isoRef);
  if (!iSnap.exists()) gate("The isolation certificate no longer exists.");
  const iso = { id: o.isoId, ...iSnap.data() };
  if (!["isolator", "admin"].includes(o.actor.role))
    gate("Only an Isolator may re-apply the locks after a trial run.");
  if (!isTrialEnergised(iso)) gate("This certificate is not in a trial run — there is nothing to re-isolate.");
  const crew = await txReadCrew(tx, o.isoId, iso, o.knownIds);
  // Same authority as energising — but no gate if it cannot be resolved.
  // Getting the certificate back to active is what unblocks hand-back, and
  // refusing that would strand the lockout; an equipment row left reading
  // "Trial Run" is a false alarm, which is the safe direction to fail.
  const eqId = iso.equipmentRef || o.equipmentId || null;
  const eqRef = eqId ? doc(db, "equipment", eqId) : null;
  const eqSnap = eqRef ? await tx.get(eqRef) : null;          // last read before any write
  const t = iso.trialRun || { status: "energised", legacy: true, permitId: null, consents: [],
                              reason: "Started by the earlier trial-run flow", requestedAt: null };
  tx.update(isoRef, {
    status: "active", trialRun: null,
    // Only a trial that actually reached ENERGISED completed. A certificate
    // carrying trialRun status over a request that never got there is an
    // inconsistent state — log it for what it is rather than claiming a run.
    trialRunLog: [...(iso.trialRunLog || []), { ...t, status: "closed",
      outcome: (!iso.trialRun || trialStage(iso) === "energised") ? "completed" : "abandoned",
      reIsolatedBy: o.actor, reIsolatedAt: o.at }]
  });
  // Only reset the equipment if it still points at THIS certificate.
  if (eqRef && eqSnap && eqSnap.exists() && (eqSnap.data().activeIsolationId || null) === o.isoId)
    tx.update(eqRef, { isolationStatus: "isolated", updatedAt: o.at });
  for (const cp of crew) {
    const trs = cp.trialRuns || [];
    if (!trs.some((x) => x && x.status === "open")) continue;
    tx.update(doc(db, "permits", cp.id), { updatedAt: o.at,
      trialRuns: trs.map((x) => x && x.status === "open" ? { ...x, reIsolatedAt: o.at, status: "closed" } : x) });
  }
}

// Wrappers the UI calls. lifecycleTx keeps every one of these off the offline
// queue — energising equipment must never be a write that "goes through later".
const trialRequest    = (o) => lifecycleTx("trial run request",   (tx) => txTrialRequest(tx, { ...o, actor: actorStamp(), at: nowISO() }));
const trialAnswer     = (o) => lifecycleTx("trial run answer",    (tx) => txTrialAnswer(tx, { ...o, actor: actorStamp(), at: nowISO() }));
const trialApprove    = (o) => lifecycleTx("trial run approval",  (tx) => txTrialApprove(tx, { ...o, actor: actorStamp(), at: nowISO() }));
const trialCancel     = (o) => lifecycleTx("trial run cancellation", (tx) => txTrialCancel(tx, { ...o, actor: actorStamp(), at: nowISO() }));
const trialEnergise   = (o) => lifecycleTx("trial run de-isolation", (tx) => txTrialEnergise(tx, { ...o, actor: actorStamp(), at: nowISO() }));
const trialComplete   = (o) => lifecycleTx("trial run sign-off", (tx) => txTrialComplete(tx, { ...o, actor: actorStamp(), at: nowISO() }));
const trialReIsolate  = (o) => lifecycleTx("re-isolation",        (tx) => txTrialReIsolate(tx, { ...o, actor: actorStamp(), at: nowISO() }));

// HTML-body confirm variant
function confirmBoxHTML(title, bodyHtml, okLabel, onOk, danger = false) {
  modal({ title, body: bodyHtml, footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(okLabel)}</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => { try { await onOk(); } catch (e) { toast(e.message || "Error", "err"); } };
}

/* -------------------- 5e. Equipment -------------------- */
async function viewEquipment(m) {
  const isIssuer = ["issuer", "admin"].includes(State.profile.role);
  const isAdmin = State.profile.role === "admin";
  const selected = new Set();
  m.innerHTML = `<div class="page-head"><div><div class="kick">Asset register</div><h2>Equipment</h2></div>
    <div class="actions">${isAdmin ? `<button class="btn btn-ghost" id="bulkArea" disabled>Bulk edit area</button>` : ""}${isAdmin ? `<button class="btn btn-ghost" id="imp">Import CSV</button>` : ""}${isAdmin ? `<button class="btn btn-ghost" id="expCsv">Export CSV</button>` : ""}${isIssuer ? `<button class="btn btn-accent" id="add">+ Add equipment</button>` : ""}</div></div>
    <div class="filters"><input class="search" id="q" placeholder="Search tag or name…">
      <select id="fLine"><option value="">All lines</option>${State.config.lines.map((l) => `<option>${esc(l)}</option>`).join("")}</select>
      <select id="fArea"><option value="">All areas</option>${State.config.areas.map((a) => `<option>${esc(a)}</option>`).join("")}</select>
      <select id="fStatus"><option value="">All statuses</option>
        <option value="isolatedAny">isolated / trial run</option>
        ${["available", "pending", "isolated", "trialRun"].map((s) => `<option>${s}</option>`).join("")}</select></div>
    <div class="card pad0" id="etable">Loading…</div>`;
  const token = LiveView.token;
  let equip = await fetchEquipment();
  let lastRows = [];
  const updateBulkBtn = () => {
    if (!isAdmin) return;
    const btn = $("#bulkArea");
    btn.textContent = selected.size ? `Bulk edit area (${selected.size})` : "Bulk edit area";
    btn.disabled = selected.size === 0;
  };
  const draw = () => {
    const q = $("#q").value.toLowerCase(), fl = $("#fLine").value, fa = $("#fArea").value, fs = $("#fStatus").value;
    const rows = equip.filter((e) => (!fl || e.line === fl) && (!fa || e.area === fa) &&
      (!fs || (fs === "isolatedAny" ? (e.isolationStatus === "isolated" || e.isolationStatus === "trialRun") : (e.isolationStatus || "available") === fs)) &&
      (!q || (e.tag + " " + e.description).toLowerCase().includes(q)));
    lastRows = rows;
    // Drop selections that have scrolled out of the current filter's result set
    // so the bulk button's count always matches what's actually selectable.
    for (const id of selected) if (!rows.some((e) => e.id === id)) selected.delete(id);
    const nCols = 5 + (isAdmin ? 1 : 0) + (isIssuer ? 1 : 0);
    $("#etable").innerHTML = `<table class="tbl"><thead><tr>${isAdmin ? `<th style="width:2rem"><input type="checkbox" id="selAll"></th>` : ""}<th>Tag</th><th>Description</th><th>Line</th><th>Area</th><th>Status</th>${isIssuer ? "<th></th>" : ""}</tr></thead><tbody>
      ${rows.map((e) => `<tr>${isAdmin ? `<td><input type="checkbox" data-sel="${e.id}"${selected.has(e.id) ? " checked" : ""}></td>` : ""}<td><span class="mono">${esc(e.tag)}</span></td><td>${esc(e.description || "—")}</td><td>${esc(e.line)}</td><td>${esc(e.area)}</td><td>${badge(e.isolationStatus || "available")}</td>${isIssuer ? `<td style="text-align:right"><button class="btn btn-ghost btn-sm" data-edit="${e.id}">Edit</button>${isAdmin ? ` <button class="btn btn-ghost btn-sm" data-del="${e.id}">Delete</button>` : ""}</td>` : ""}</tr>`).join("")
      || `<tr><td colspan="${nCols}" class="empty">No equipment yet. ${isIssuer ? "Add one or import a CSV." : ""}</td></tr>`}</tbody></table>`;
    if (isAdmin) {
      $$("[data-sel]").forEach((cb) => cb.onchange = () => {
        if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel);
        const selAll = $("#selAll");
        if (selAll) selAll.checked = rows.length > 0 && rows.every((e) => selected.has(e.id));
        updateBulkBtn();
      });
      const selAll = $("#selAll");
      selAll.checked = rows.length > 0 && rows.every((e) => selected.has(e.id));
      selAll.onchange = () => {
        rows.forEach((e) => selAll.checked ? selected.add(e.id) : selected.delete(e.id));
        draw();
        updateBulkBtn();
      };
      updateBulkBtn();
      $$("[data-del]").forEach((b) => b.onclick = () => {
        const it = equip.find((e) => e.id === b.dataset.del);
        if (it) openDeleteEquipment(it, () => { equip = equip.filter((e) => e.id !== it.id); selected.delete(it.id); draw(); });
      });
    }
    if (isIssuer) $$("[data-edit]").forEach((b) => b.onclick = () => {
      const it = equip.find((e) => e.id === b.dataset.edit);
      // Replace the row rather than mutating it: document objects come from the
      // Store's shared copy, so assigning onto one would edit what every other
      // view sees, without going through the listener.
      if (it) openEditEquipment(it, equip, (upd) => {
        const ix = equip.indexOf(it);
        if (ix >= 0) equip[ix] = { ...it, ...upd };
        draw();
      });
    });
  };
  if (State.params.status) $("#fStatus").value = State.params.status;
  $("#q").addEventListener("input", debounce(draw));
  ["fLine", "fArea", "fStatus"].forEach((id) => $("#" + id).addEventListener("input", draw));
  draw();
  // Filters, search text and any tick-box selection survive: draw() rewrites
  // only #etable and re-reads `selected` as it goes.
  LiveView.bind(token, async () => {
    equip = await fetchEquipment();
    if ($("#etable")) draw();
  });
  if (isIssuer) {
    $("#add").onclick = () => openAddEquipment(equip, (added) => { equip.push(added); draw(); });
  }
  if (isAdmin) {
    $("#imp").onclick = () => openImport(equip, (newList) => { equip = newList; draw(); });
    $("#expCsv").onclick = () => exportEquipmentCsv(lastRows);
    $("#bulkArea").onclick = () => {
      const items = equip.filter((e) => selected.has(e.id));
      if (!items.length) return;
      openBulkEditEquipmentArea(items, (area) => {
        items.forEach((it) => { it.area = area; });
        selected.clear();
        draw();
      });
    };
  }
}

// Download the currently-filtered equipment register. The first four columns
// match the Import CSV header, so an export can be re-imported as-is.
function exportEquipmentCsv(rows) {
  if (!rows || !rows.length) return toast("Nothing to export for the current filter", "err");
  const cols = [
    ["tag", (e) => e.tag],
    ["description", (e) => e.description || ""],
    ["line", (e) => e.line || ""],
    ["area", (e) => e.area || ""],
    ["status", (e) => STATUS_LABEL[e.isolationStatus || "available"] || e.isolationStatus]
  ];
  downloadCsv(cols, rows, `equipment-${nowISO().slice(0, 10)}.csv`);
  toast(`Exported ${rows.length} equipment item(s)`, "ok");
}

function openAddEquipment(existing, onAdded) {
  const cfg = State.config;
  modal({ title: "Add equipment", body: `
    <label class="field"><span>Tag <span class="req">*</span></span><input type="text" id="aTag" placeholder="e.g. 362FN1"></label>
    <div id="dupWarn"></div>
    <label class="field"><span>Description</span><input type="text" id="aDesc" placeholder="e.g. Raw Mill Circulation Fan"></label>
    <div class="grid-2">
      <label class="field"><span>Line</span><select id="aLine">${cfg.lines.map((l) => `<option>${esc(l)}</option>`).join("")}</select></label>
      <label class="field"><span>Area</span><select id="aArea">${cfg.areas.map((a) => `<option>${esc(a)}</option>`).join("")}</select></label>
    </div>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok>Add</button>` });
  $("[data-c]").onclick = closeModal;
  const tagInput = $("#aTag");
  tagInput.addEventListener("input", () => {
    const t = tagInput.value.trim().toLowerCase();
    const dup = existing.find((e) => e.tag.toLowerCase() === t || (t && e.tag.toLowerCase().includes(t) && t.length > 2));
    $("#dupWarn").innerHTML = dup ? `<div class="warn-box">Possible duplicate: <b class="mono">${esc(dup.tag)}</b> ${esc(dup.description || "")}. Check before adding.</div>` : "";
  });
  $("[data-ok]").onclick = async () => {
    const tag = tagInput.value.trim();
    if (!tag) return toast("Enter a tag", "err");
    if (existing.some((e) => e.tag.toLowerCase() === tag.toLowerCase())) return toast("That tag already exists", "err");
    const rec = { tag, description: $("#aDesc").value.trim(), line: $("#aLine").value, area: $("#aArea").value, isolationStatus: "available", activeIsolationId: null, createdBy: State.profile.name, createdAt: nowISO() };
    try { const ref = await addDoc(collection(db, "equipment"), rec); Store.markStale("equipment"); closeModal(); toast("Equipment added", "ok"); onAdded({ id: ref.id, ...rec }); }
    catch (e) { toast(e.message, "err"); }
  };
}

// Edit an existing equipment record (tag / description / line / area). Issuers
// and Admins only — wired in from the equipment table's per-row Edit button.
function openEditEquipment(item, existing, onSaved) {
  const cfg = State.config;
  modal({ title: "Edit equipment", body: `
    <label class="field"><span>Tag <span class="req">*</span></span><input type="text" id="eTag" value="${esc(item.tag)}"></label>
    <div id="dupWarn"></div>
    <label class="field"><span>Description</span><input type="text" id="eDesc" value="${esc(item.description || "")}" placeholder="e.g. Raw Mill Circulation Fan"></label>
    <div class="grid-2">
      <label class="field"><span>Line</span><select id="eLine">${cfg.lines.map((l) => `<option${l === item.line ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <label class="field"><span>Area</span><select id="eArea">${cfg.areas.map((a) => `<option${a === item.area ? " selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
    </div>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok>Save</button>` });
  $("[data-c]").onclick = closeModal;
  const tagInput = $("#eTag");
  tagInput.addEventListener("input", () => {
    const t = tagInput.value.trim().toLowerCase();
    const dup = existing.find((e) => e.id !== item.id && e.tag.toLowerCase() === t);
    $("#dupWarn").innerHTML = dup ? `<div class="warn-box">Another item already uses tag <b class="mono">${esc(dup.tag)}</b>.</div>` : "";
  });
  $("[data-ok]").onclick = async () => {
    const tag = tagInput.value.trim();
    if (!tag) return toast("Enter a tag", "err");
    if (existing.some((e) => e.id !== item.id && e.tag.toLowerCase() === tag.toLowerCase())) return toast("That tag already exists", "err");
    const upd = { tag, description: $("#eDesc").value.trim(), line: $("#eLine").value, area: $("#eArea").value };
    try { await updateDoc(doc(db, "equipment", item.id), upd); Store.markStale("equipment"); closeModal(); toast("Equipment updated", "ok"); onSaved(upd); }
    catch (e) { toast(e.message, "err"); }
  };
}

// Bulk-edit the Area field across a set of already-selected equipment records.
// Wired in from the equipment table's checkbox column + "Bulk edit area" button,
// admin only. Writes are chunked in groups of 400 (Firestore batch limit
// is 500), mirroring the pattern used by openImport's full-replace mode.
function openBulkEditEquipmentArea(items, onDone) {
  const cfg = State.config;
  modal({ title: "Bulk edit area", body: `
    <div class="info-box">Set the Area for <b>${items.length}</b> selected equipment record${items.length === 1 ? "" : "s"}:
      <span class="mono">${items.slice(0, 6).map((e) => esc(e.tag)).join(", ")}${items.length > 6 ? `, +${items.length - 6} more` : ""}</span></div>
    <label class="field"><span>Area</span><select id="bArea">${cfg.areas.map((a) => `<option>${esc(a)}</option>`).join("")}</select></label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok>Apply</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => {
    const area = $("#bArea").value;
    $("[data-ok]").disabled = true;
    try {
      for (let i = 0; i < items.length; i += 400) {
        const batch = writeBatch(db);
        items.slice(i, i + 400).forEach((e) => batch.update(doc(db, "equipment", e.id), { area, updatedAt: nowISO() }));
        await fsWrite(batch.commit());
      }
      closeModal();
      toast(`Area updated for ${items.length} equipment`, "ok");
      onDone(area);
    } catch (e) { toast(e.message, "err"); $("[data-ok]").disabled = false; }
  };
}

// Admin-only equipment delete. A hard delete is allowed only for equipment that
// nothing references; anything referenced by a permit or certificate is offered
// Archive instead (preserving history). Equipment under a live isolation is
// blocked outright.
async function openDeleteEquipment(item, onChanged) {
  if (item.isolationStatus && item.isolationStatus !== "available")
    return toast(`${item.tag} is under isolation and cannot be deleted. De-isolate it first.`, "err");
  const [permits, isos] = await Promise.all([fetchPermits(), fetchIsolations()]);
  const refCount = permits.filter((p) => p.equipmentRef === item.id).length
                 + isos.filter((i) => i.equipmentRef === item.id).length;
  if (refCount > 0) {
    return confirmBoxHTML("Cannot delete — records reference this equipment",
      `<div class="warn-box"><b>${esc(item.tag)}</b> is referenced by <b>${refCount}</b> permit(s) / certificate(s). Hard-deleting it would leave those records without a live equipment link.</div>
       <p>Archive it instead? Archiving hides it from the active list but keeps it so historical records stay intact. (Reversible.)</p>`,
      "Archive instead", async () => {
        await fsWrite(updateDoc(doc(db, "equipment", item.id), { archived: true, archivedAt: nowISO(), archivedBy: State.profile.name, updatedAt: nowISO() }));
        Store.markStale("equipment"); closeModal(); toast(`${item.tag} archived`, "ok"); onChanged();
      });
  }
  confirmBoxHTML("Delete equipment",
    `<div class="danger-box">Permanently delete <b>${esc(item.tag)}</b>? This cannot be undone.</div>
     <p>No permits or certificates reference this equipment, so it is safe to remove.</p>`,
    "Delete permanently", async () => {
      await fsWrite(deleteDoc(doc(db, "equipment", item.id)));
      Store.markStale("equipment"); closeModal(); toast(`${item.tag} deleted`, "ok"); onChanged();
    }, true);
}

function openImport(existing, onDone) {
  modal({ title: "Import equipment (CSV)", wide: true, body: `
    <div class="info-box">CSV columns: <b>tag, description, line, area</b> (first row = header). In normal mode, tags that already exist are skipped (no duplicates).</div>
    <label class="checkline" style="margin:.2rem 0 .6rem"><input type="checkbox" id="repl"> <b>Full replace</b> — archive all ${existing.length} current equipment, then import the CSV as a fresh list. Archived items are hidden but kept, so historical permits &amp; certificates stay intact. (Reversible.)</label>
    <input type="file" id="csv" accept=".csv,text/csv">
    <div id="prev" style="margin-top:1rem"></div>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok disabled>Import</button>` });
  $("[data-c]").onclick = closeModal;
  let raw = [];      // every parsed CSV row (before dedup)
  let parsed = [];   // rows that will actually be imported
  const recompute = () => {
    const replace = $("#repl").checked;
    parsed = replace ? raw.slice() : raw.filter((x) => !existing.some((e) => e.tag.toLowerCase() === x.tag.toLowerCase()));
    if (!raw.length) { $("#prev").innerHTML = ""; $("[data-ok]").disabled = true; return; }
    $("#prev").innerHTML = replace
      ? `<div class="warn-box"><b>${existing.length}</b> current equipment will be <b>archived</b> and <b>${parsed.length}</b> new rows imported.</div>`
      : `<b>${parsed.length}</b> new rows ready (duplicates skipped).`;
    $("[data-ok]").disabled = parsed.length === 0;
  };
  $("#repl").onchange = recompute;
  $("#csv").onchange = (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      // Strip a leading UTF-8 BOM (Excel "CSV" often adds one) — otherwise the
      // first header cell becomes "﻿tag" and the tag column is never found,
      // silently importing zero rows.
      const lines = r.result.replace(/^﻿/, "").split(/\r?\n/).filter((x) => x.trim());
      const head = parseCsvLine(lines.shift()).map((h) => h.toLowerCase());
      const idx = (k) => head.indexOf(k);
      raw = lines.map((ln) => { const c = parseCsvLine(ln); return {
        tag: (c[idx("tag")] || "").trim(), description: (c[idx("description")] || "").trim(),
        line: (c[idx("line")] || State.config.lines[0]).trim(), area: (c[idx("area")] || State.config.areas[0]).trim() }; })
        .filter((x) => x.tag);
      recompute();
    };
    r.readAsText(file);
  };
  $("[data-ok]").onclick = async () => {
    const replace = $("#repl").checked;
    // Safety pre-check for a full replace: never archive equipment that is still
    // under any isolation (isolated / pending / trial run). Doing so would strand
    // a live LOTO while a same-tag new record appears "Available".
    if (replace) {
      const live = existing.filter((e) => e.isolationStatus && e.isolationStatus !== "available");
      if (live.length) return toast(`Cannot replace: ${live.length} item(s) are still under isolation (${live.slice(0, 3).map((e) => e.tag).join(", ")}${live.length > 3 ? "…" : ""}). De-isolate first.`, "err");
    }
    $("[data-ok]").disabled = true;
    try {
      // Auto-sync config: add any line/area values found in the CSV that aren't
      // already configured, so the register filters and the Add/Edit dropdowns
      // include them (otherwise imported values can't be filtered and get reset
      // to the first option if the item is edited).
      const cfgLines = State.config.lines || [], cfgAreas = State.config.areas || [];
      const newLines = [...new Set(parsed.map((x) => x.line).filter(Boolean))].filter((l) => !cfgLines.includes(l));
      const newAreas = [...new Set(parsed.map((x) => x.area).filter(Boolean))].filter((a) => !cfgAreas.includes(a));
      if (newLines.length || newAreas.length) {
        const lines = [...cfgLines, ...newLines], areas = [...cfgAreas, ...newAreas];
        await fsWrite(updateDoc(doc(db, "config", "app"), { lines, areas }));
        State.config = { ...State.config, lines, areas };
      }
      // Batched writes (chunks of 400 — Firestore batch limit is 500), each chunk
      // atomic. Archive first, then import the fresh set.
      if (replace) {
        for (let i = 0; i < existing.length; i += 400) {
          const batch = writeBatch(db);
          existing.slice(i, i + 400).forEach((e) => batch.update(doc(db, "equipment", e.id),
            { archived: true, archivedAt: nowISO(), archivedBy: State.profile.name, updatedAt: nowISO() }));
          await fsWrite(batch.commit());
        }
      }
      for (let i = 0; i < parsed.length; i += 400) {
        const batch = writeBatch(db);
        parsed.slice(i, i + 400).forEach((x) => batch.set(doc(collection(db, "equipment")),
          { ...x, isolationStatus: "available", activeIsolationId: null, archived: false, createdBy: State.profile.name, createdAt: nowISO() }));
        await fsWrite(batch.commit());
      }
      closeModal();
      toast(replace ? `Archived ${existing.length}, imported ${parsed.length} equipment` : `Imported ${parsed.length} equipment`, "ok");
      Store.markStale("equipment");
      onDone(await fetchEquipment());
    } catch (e) { toast(e.message, "err"); }
  };
}

/* -------------------- 5f. Administration -------------------- */
async function viewAdmin(m) {
  m.innerHTML = `<div class="page-head"><div><div class="kick">Administration</div><h2>Users & Configuration</h2></div></div>
    <div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Users</h3></div>
      <div id="users">Loading…</div></div>
    <div class="card"><h3>Configuration</h3><div class="csub">Permit types, lines, areas and departments are stored in <span class="mono">config/app</span>. Edit lists below.</div>
      <div class="cols cols-2">
        <div><div class="section-title">Lines</div><textarea id="cLines" rows="4">${esc((State.config.lines || []).join("\n"))}</textarea></div>
        <div><div class="section-title">Areas</div><textarea id="cAreas" rows="6">${esc((State.config.areas || []).join("\n"))}</textarea></div>
      </div>
      <div class="section-title">Departments (format: Department: sub, sub, sub)</div>
      <textarea id="cDepts" rows="4">${esc((State.config.departments || []).map((d) => d.name + (d.subUnits?.length ? ": " + d.subUnits.join(", ") : "")).join("\n"))}</textarea>
      <div class="section-title">PPE options</div>
      <textarea id="cPpe" rows="3">${esc((State.config.ppeList || []).join("\n"))}</textarea>
      <div class="section-title">Job Titles (one per line — order is preserved; used in sign-up and user management)</div>
      <textarea id="cTitles" rows="6">${esc(jobTitles().join("\n"))}</textarea>
      <div class="section-title">Auto-rejection</div>
      <div class="csub">A permit left undecided past its deadline is auto-rejected: it leaves the approval queue and stops holding its equipment out of service. It is never recorded as a rejection by a person, and a permit whose lockout has already been applied or is shared is never auto-rejected — an Issuer must handle those. A permit's own planned end always applies as well, whichever falls first.</div>
      <div class="grid-3">
        <label class="field"><span>Awaiting approval (hours)</span><input type="number" min="1" step="1" id="cArSub" value="${esc(autoRejectPolicy().submittedHours)}"></label>
        <label class="field"><span>Awaiting isolation (hours)</span><input type="number" min="1" step="1" id="cArIso" value="${esc(autoRejectPolicy().awaitingIsolationHours)}"></label>
        <label class="field"><span>Reinstatement window (hours)</span><input type="number" min="0" step="1" id="cArRe" value="${esc(autoRejectPolicy().reinstateHours)}"></label>
      </div>
      <label class="checkline"><input type="checkbox" id="cArOn" ${autoRejectPolicy().enabled === false ? "" : "checked"}> Auto-rejection enabled</label>
      <div style="margin-top:1rem;text-align:right"><button class="btn btn-accent" id="saveCfg">Save configuration</button></div>
    </div>
    <div class="card"><h3>Data audit</h3>
      <div class="csub">Read-only check for permits, certificates and equipment that reference each other inconsistently — most importantly a lockout that its equipment record does not point at, which nothing derived from the equipment can see. Changes nothing.</div>
      <div style="margin-top:1rem"><button class="btn btn-ghost" id="runAudit">Run data audit</button></div>
      <div id="auditOut"></div>
    </div>`;
  // users
  const users = await fetchAll("users");
  $("#users").innerHTML = `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Job Title</th><th>Department</th><th>Employee No.</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email || "—")}</td>
      <td><select data-jt="${u.id}">${optionList(jobTitles(), u.jobTitle || u.position || "")}</select></td>
      <td><select data-dp="${u.id}">${optionList(departmentNames(), u.department || "")}</select></td>
      <td><input type="text" data-en="${u.id}" value="${esc(u.employeeNumber || "")}" placeholder="EMP-…" style="min-width:110px"></td>
      <td><select data-role="${u.id}" ${u.id === State.profile.id ? "disabled" : ""}>
        ${["requester", "issuer", "admin", "isolator"].map((r) => `<option ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
      <td><label class="checkline" style="padding:0"><input type="checkbox" data-active="${u.id}" ${u.active ? "checked" : ""} ${u.id === State.profile.id ? "disabled" : ""}></label></td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-saveu="${u.id}">Save</button>
        ${u.email ? `<button class="btn btn-ghost btn-sm" data-resetu="${esc(u.email)}">Reset PW</button>` : ""}
        ${u.id === State.profile.id ? "" : `<button class="btn btn-danger btn-sm" data-delu="${u.id}" data-name="${esc(u.name || u.email || "this user")}">Delete</button>`}
      </td></tr>`).join("")}</tbody></table></div>`;
  $$("[data-saveu]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.saveu;
    const role = $(`[data-role="${id}"]`).value, active = $(`[data-active="${id}"]`).checked;
    const jobTitle = $(`[data-jt="${id}"]`).value, department = $(`[data-dp="${id}"]`).value, employeeNumber = $(`[data-en="${id}"]`).value.trim();
    try { await updateDoc(doc(db, "users", id), { role, active, jobTitle, department, employeeNumber }); toast("User updated", "ok"); } catch (e) { toast(e.message, "err"); }
  });
  $$("[data-resetu]").forEach((b) => b.onclick = async () => {
    try { await sendPasswordResetEmail(auth, b.dataset.resetu); toast(`Password reset email sent to ${b.dataset.resetu}`, "ok"); }
    catch (e) { toast(friendlyAuthError(e), "err"); }
  });
  $$("[data-delu]").forEach((b) => b.onclick = () => confirmBox(
    "Delete user",
    `Remove ${b.dataset.name} from the system? They lose all access immediately. Their sign-in credential remains but is inert until an Admin re-approves them.`,
    "Delete user",
    async () => { await deleteDoc(doc(db, "users", b.dataset.delu)); closeModal(); toast("User deleted", "ok"); go("admin"); },
    true));
  // config save
  $("#saveCfg").onclick = async () => {
    const lines = $("#cLines").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const areas = $("#cAreas").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const ppeList = $("#cPpe").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const jobTitlesList = $("#cTitles").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const departments = $("#cDepts").value.split(/\n/).map((s) => s.trim()).filter(Boolean).map((ln) => {
      const [name, subs] = ln.split(":"); return { name: name.trim(), subUnits: (subs || "").split(",").map((x) => x.trim()).filter(Boolean) };
    });
    // Blank or nonsense hours fall back to the built-in default rather than to
    // zero — a zero here would auto-reject every permit the moment it was raised.
    const hrs = (el, dflt) => { const n = parseInt($(el).value, 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };
    const autoReject = {
      enabled: $("#cArOn").checked,
      submittedHours: hrs("#cArSub", AUTO_REJECT_DEFAULT.submittedHours) || AUTO_REJECT_DEFAULT.submittedHours,
      awaitingIsolationHours: hrs("#cArIso", AUTO_REJECT_DEFAULT.awaitingIsolationHours) || AUTO_REJECT_DEFAULT.awaitingIsolationHours,
      reinstateHours: hrs("#cArRe", AUTO_REJECT_DEFAULT.reinstateHours)
    };
    try {
      await updateDoc(doc(db, "config", "app"), { lines, areas, ppeList, departments, jobTitles: jobTitlesList, autoReject });
      State.config = { ...State.config, lines, areas, ppeList, departments, jobTitles: jobTitlesList, autoReject };
      toast("Configuration saved", "ok");
    } catch (e) { toast(e.message, "err"); }
  };

  $("#runAudit").onclick = async () => {
    const out = $("#auditOut");
    out.innerHTML = `<div class="help" style="margin-top:1rem">Reading all permits, certificates and equipment…</div>`;
    try {
      // Fresh from the server — an audit that reports on a cached copy is
      // worthless. Equipment unfiltered: an ARCHIVED record still holds the
      // pointer a live certificate has to be checked against, and fetchEquipment
      // hides those.
      const [permits, isolations, equipment] = await Promise.all([
        fetchAll("permits", { fresh: true }),
        fetchAll("isolations", { fresh: true }),
        fetchAll("equipment", { fresh: true })
      ]);
      const findings = auditData(permits, isolations, equipment);
      const critical = findings.filter((f) => f.severity === "critical");
      const scanned = `<div class="help" style="margin-top:.8rem">Checked ${permits.length} permit(s), ${isolations.length} certificate(s), ${equipment.length} equipment record(s).</div>`;
      if (!findings.length) {
        out.innerHTML = `<div class="ok-box" style="margin-top:1rem"><b>No inconsistencies found.</b> Every live permit and certificate is accounted for by its equipment record.</div>${scanned}`;
        return;
      }
      out.innerHTML = findings.map((f) => `
        <div class="${f.severity === "critical" ? "danger-box" : "warn-box"}" style="margin-top:1rem">
          <b>${esc(f.title)} — ${f.items.length}</b>
          <div style="margin:.3rem 0 .5rem">${esc(f.why)}</div>
          <div class="attached-list">${f.items.slice(0, 25).map((it) => `<div class="a">
            ${it.view && it.id ? `<a href="#" data-goto="${esc(it.view)}" data-gid="${esc(it.id)}"><span class="mono">${esc(it.label)}</span></a>` : `<span class="mono">${esc(it.label)}</span>`}
            <span style="color:var(--muted)">— ${esc(it.note)}</span></div>`).join("")}
            ${f.items.length > 25 ? `<div class="a"><span style="color:var(--muted)">…and ${f.items.length - 25} more</span></div>` : ""}
          </div>
        </div>`).join("") +
        (critical.length
          ? `<div class="danger-box" style="margin-top:1rem"><b>${critical.length} critical finding type(s).</b> These are the cases where a lockout exists that its equipment record cannot see. Resolve them before availability is decided from the equipment record alone.</div>`
          : `<div class="info-box" style="margin-top:1rem">No critical findings — every live lockout is visible from its equipment record.</div>`) + scanned;
      out.querySelectorAll("[data-goto]").forEach((a) => a.onclick = (e) => {
        e.preventDefault(); go(a.dataset.goto, { id: a.dataset.gid });
      });
    } catch (e) {
      out.innerHTML = `<div class="danger-box" style="margin-top:1rem">Could not run the audit: ${esc(e.message || String(e))}</div>`;
    }
  };
}

/* -------------------- 7. Print / PDF -------------------- */
function printPermit(p, equip, iso) {
  const row = (k, v) => `<tr><td style="padding:4px 10px;color:#555;width:170px">${k}</td><td style="padding:4px 10px;font-weight:600">${v}</td></tr>`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#15293B;max-width:760px;margin:0 auto;padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #0E2A47;padding-bottom:10px">
        <div><div style="font-size:20px;font-weight:800">WORK PERMIT</div>
          <div style="color:#666">${esc(appBranding.company)} · ${esc(appBranding.site)}</div></div>
        <div style="text-align:right"><div style="font-size:18px;font-weight:800;color:#0E2A47">${esc(p.permitNo)}</div>
          <div style="color:#666">${esc(p.typeName)}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:14px">
        ${row("Status", esc(p.status.toUpperCase()))}
        ${row("Equipment", esc(p.equipmentTag) + (equip ? " · " + esc(equip.line) + " / " + esc(equip.area) : ""))}
        ${p.isoNo ? row("Isolation certificate", esc(p.isoNo)) : ""}
        ${row("Requester", personHTML(p.requester?.name, p.requester))}
        ${row("Department", esc(p.requestingDepartment?.department || "—") + (p.requestingDepartment?.subUnit ? " · " + esc(p.requestingDepartment.subUnit) : ""))}
        ${row("Work", esc(p.workDescription))}
        ${row("Valid from", fmt(p.validity?.start))}
        ${row("Valid to", p.validity?.openEnded ? "Open (while active)" : fmt(p.validity?.extendedTo || p.validity?.plannedEnd))}
        ${p.approval ? row("Approved by", personHTML(p.approval.issuerName, p.approval) + " · " + fmt(p.approval.timestamp)) : ""}
        ${p.workCompletion ? row("Work completed / safe to return", personHTML(p.workCompletion.name, p.workCompletion) + " · " + fmt(p.workCompletion.timestamp) + (p.workCompletion.remarks ? " · " + esc(p.workCompletion.remarks) : "")) : ""}
        ${p.closure ? row("Closed by", personHTML(p.closure.name, p.closure) + " · " + fmt(p.closure.timestamp)) : ""}
      </table>
      <div style="margin-top:14px;font-weight:800;color:#2A6F97;font-size:13px">HAZARD CHECKLIST</div>
      <div>${(p.checklist || []).map((c) => `<div>${c.checked ? "☑" : "☐"} ${esc(c.item)}</div>`).join("")}</div>
      <div style="margin-top:10px;font-weight:800;color:#2A6F97;font-size:13px">PPE</div>
      <div>${(p.ppe || []).join(", ") || "—"}</div>
      ${p.isolationPoints?.length ? `<div style="margin-top:10px;font-weight:800;color:#2A6F97;font-size:13px">ISOLATION REGISTER</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #ccc"><tr style="background:#f2f5f8"><th style="text-align:left;padding:5px">Point</th><th style="text-align:left;padding:5px">Method</th><th style="text-align:left;padding:5px">Lock/Tag</th></tr>
        ${p.isolationPoints.map((i) => `<tr><td style="padding:5px;border-top:1px solid #eee">${esc(i.point)}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.method || "")}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.lockTag || "")}</td></tr>`).join("")}</table>` : ""}
      ${trialPrintHTML(iso, p)}
      ${p.gasTest ? `<div style="margin-top:10px;font-weight:800;color:#2A6F97;font-size:13px">GAS TEST</div><div>O₂ ${esc(p.gasTest.o2 || "—")} · LEL ${esc(p.gasTest.lel || "—")} · H₂S ${esc(p.gasTest.h2s || "—")} · CO ${esc(p.gasTest.co || "—")} ${p.gasTest.by ? "· by " + esc(p.gasTest.by) : ""}</div>` : ""}
      <div style="margin-top:34px;display:flex;justify-content:space-between">
        <div style="border-top:1px solid #333;width:42%;padding-top:5px;font-size:12px">Requester signature</div>
        <div style="border-top:1px solid #333;width:42%;padding-top:5px;font-size:12px">Issuer signature</div>
      </div>
      <div style="margin-top:20px;color:#999;font-size:11px">Generated ${fmt(nowISO())} · NRCC Work Permit System</div>
    </div>`;
  $("#print-area").innerHTML = html;
  window.print();
}

/* -------------------- 8. Isolation certificates -------------------- */
function makeIsoNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `NRCC-ISO-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function tabsHtml(cur) {
  return `<div style="display:flex;gap:.5rem;margin-bottom:1rem">
    <button class="btn ${cur === "p" ? "btn-primary" : "btn-ghost"} btn-sm" data-tabp>Work Permits</button>
    <button class="btn ${cur === "i" ? "btn-primary" : "btn-ghost"} btn-sm" data-tabi>Isolation Certificates</button></div>`;
}
function bindTabs() {
  const a = $("[data-tabp]"), b = $("[data-tabi]");
  if (a) a.onclick = () => go("permits");
  if (b) b.onclick = () => go("isolations");
}

async function viewIsolations(m) {
  m.innerHTML = `<div class="page-head"><div><div class="kick">Records</div><h2>Isolation Certificates</h2></div></div>
    ${tabsHtml("i")}
    <div class="filters"><input class="search" id="q" placeholder="Search certificate no or equipment…">
      <select id="fs"><option value="">All statuses</option>
        <option value="pendingDeiso">pending de-isolation</option>
        ${["assigned", "active", "trialRun", "removalPending", "removed"].map((s) => `<option>${s}</option>`).join("")}</select></div>
    <div class="card pad0" id="itable">Loading…</div>`;
  bindTabs();
  if (State.params.status) $("#fs").value = State.params.status;   // arrived from a dashboard tile
  const token = LiveView.token;
  // Permits are needed only to derive readiness for de-isolation — a
  // certificate whose crews have all signed off carries no status of its own
  // saying so — but that derivation is what the Isolator's queue is, so load
  // them alongside the certificates rather than after.
  let [all, permits] = await Promise.all([fetchIsolations(), fetchPermits().catch(() => [])]);
  // Readiness depends only on the loaded data, so compute it per load, not per
  // keystroke: draw() runs on every filter change and search character.
  let ready = new Set();
  const index = () => {
    const byIso = permitsByIso(permits);
    ready = new Set(all.filter((i) => isoReadyForDeiso(i, permits, byIso)).map((i) => i.id));
  };
  index();
  const draw = () => {
    const q = $("#q").value.toLowerCase(), fs = $("#fs").value;
    const rows = all.filter((i) =>
      (!fs || (fs === "pendingDeiso" ? i.status === "removalPending" || ready.has(i.id) : i.status === fs)) &&
      (!q || ((i.isoNo || "") + " " + i.equipmentTag).toLowerCase().includes(q)));
    $("#itable").innerHTML = `<table class="tbl"><thead><tr><th>Certificate</th><th>Equipment</th><th>Status</th><th>Assigned to</th><th>Permits</th><th>Created</th></tr></thead><tbody>
      ${rows.map((i) => { const deiso = i.status === "removalPending" || ready.has(i.id); return `<tr class="row" data-iid="${i.id}">
        <td><span class="mono">${esc(i.isoNo || i.id)}</span></td><td>${esc(i.equipmentTag)}</td>
        <td>${badge(deiso ? "removalPending" : i.status)}</td><td>${esc((deiso ? i.removalAssignedTo?.name : i.assignedTo?.name) || "—")}</td>
        <td>${(i.attachedPermitIds || []).length}</td><td>${fmtDate(i.createdAt)}</td></tr>`; }).join("")
      || `<tr><td colspan="6" class="empty">No certificates yet — they are created when isolation permits are approved.</td></tr>`}</tbody></table>`;
    $$("tr.row[data-iid]").forEach((r) => r.onclick = () => go("isodetail", { id: r.dataset.iid }));
  };
  $("#q").addEventListener("input", debounce(draw));
  $("#fs").addEventListener("input", draw);
  draw();
  LiveView.bind(token, async () => {
    [all, permits] = await Promise.all([fetchIsolations(), fetchPermits().catch(() => [])]);
    index();
    if ($("#itable")) draw();
  });
}

async function viewIsolationDetail(m) {
  m.innerHTML = `<div>Loading…</div>`;
  const id = State.params.id;
  const s = await getDoc(doc(db, "isolations", id));
  if (!s.exists()) { m.innerHTML = `<div class="danger-box">Certificate not found.</div>`; return; }
  const iso = { id, ...s.data() };
  // The equipment record and the attached-permit list are independent of each
  // other, so load them concurrently.
  const [eqS, permits] = await Promise.all([
    getDoc(doc(db, "equipment", iso.equipmentRef)).catch(() => null),
    fetchPermits()
  ]);
  const equip = eqS && eqS.exists() ? { id: eqS.id, ...eqS.data() } : null;
  const attached = permits.filter((p) => p.isolationRef === id);
  const me = State.profile.id, canI = ["issuer", "admin"].includes(State.profile.role);
  const isAdmin = State.profile.role === "admin";
  // Any active Isolator may confirm — the lockout is done by whoever is on
  // shift, not only the named assignee. The actual signer is stamped below.
  const isIso = State.profile.role === "isolator";
  // Confirming the physical isolation is the Isolator's safety responsibility.
  // The Issuer creates and assigns the certificate but must NOT sign that locks
  // are applied — that separation is the whole point of the role. Admin is kept
  // only as a system superuser fallback (mirrors the de-isolation rule below).
  const canConfirm = iso.status === "assigned" && (isIso || isAdmin || iso.assignedTo?.uid === me);
  // De-isolation opens automatically once all crews on a confirmed certificate
  // have signed off their work complete (readyForDeiso), as well as for any
  // certificate explicitly put into removalPending by an older flow.
  // De-isolation is the Isolator's physical job — the Issuer does NOT de-isolate
  // (Admin is kept only as a system superuser fallback).
  const readyForDeiso = isoReadyForDeiso(iso, permits);
  // A trial run in flight freezes hand-back. Energised is obvious — the locks
  // are out. A merely requested or authorised one matters too: taking the locks
  // off for good while a crew is waiting to energise leaves a live request
  // pointing at a dead certificate, and the crew watching this page would have
  // no idea their trial had been overtaken.
  const trialAt = trialStage(iso);
  const energised = isTrialEnergised(iso);
  const trialC = trialConsentState(iso, attached);
  const trialHolds = !!iso.trialRun || energised;
  const canRemove = (iso.status === "removalPending" || readyForDeiso) && !trialHolds
    && (isIso || isAdmin || iso.removalAssignedTo?.uid === me);
  // An active certificate with no open permits is orphaned — let an
  // Issuer/Admin release it directly to return the equipment to service.
  const openAttached = attached.filter((p) => ["draft", "submitted", "awaitingIsolation", "active", "extended"].includes(p.status));
  const canRelease = canI && iso.status === "active" && openAttached.length === 0 && !trialHolds;
  // The Isolator's two steps, offered where Isolators actually work. Requesting
  // and clearing stay on the crews' own permits — those are the crew's word
  // about their own people, and this page does not know which crew you are.
  const canEnergise = trialAt === "approved" && (isIso || isAdmin);
  const canReIsolate = energised && (isIso || isAdmin);
  const canAuthorise = trialAt === "requested" && canI
    && !trialC.outstanding.length && !trialC.refused.length;
  const canCancelTrial = ["requested", "approved"].includes(trialAt)
    && (canI || iso.trialRun?.requestedBy?.uid === me);

  let actions = "";
  if (canConfirm) actions += `<button class="btn btn-success" id="conf">Confirm isolation applied</button>`;
  if (canRemove) actions += `<button class="btn btn-success" id="rem">Confirm de-isolation complete</button>`;
  if (canRelease) actions += `<button class="btn btn-danger" id="release">Release isolation (return to service)</button>`;
  if (canAuthorise) actions += `<button class="btn btn-danger" id="itrialOk">Authorise trial run</button>`;
  if (canEnergise) actions += `<button class="btn btn-danger" id="itrialGo">De-isolate for trial run</button>`;
  if (canReIsolate) actions += `<button class="btn btn-success" id="itrialBack">Re-isolate after trial run</button>`;
  if (canCancelTrial) actions += `<button class="btn btn-ghost" id="itrialCancel">Cancel trial run</button>`;
  actions += `<button class="btn btn-ghost no-print" id="ipdf">${ICON.pdf} Print / PDF</button>`;

  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  m.innerHTML = `
    <div class="page-head"><div><div class="kick">Isolation Certificate</div>
      <h2 style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap"><span class="mono" style="font-size:1.1rem">${esc(iso.isoNo || iso.id)}</span> ${badge(iso.status)}${trialChip(iso)}</h2></div>
      <div class="actions">${actions}</div></div>
    ${energised ? `<div class="danger-box"><b>⚠ TRIAL RUN IN PROGRESS — ${esc(iso.equipmentTag || "the equipment")} is ENERGISED.</b>
      The locks are OUT. ${isIso || isAdmin ? "Re-isolate as soon as the trial is finished." : "An Isolator must re-isolate before any work resumes."}
      ${iso.trialRun?.deisolatedBy ? `<div style="margin-top:.35rem">Removed by ${personHTML(iso.trialRun.deisolatedBy.name, iso.trialRun.deisolatedBy)} · ${fmt(iso.trialRun.deisolatedAt)}.</div>` : ""}
      ${iso.trialRun?.completedBy ? `<div style="margin-top:.35rem"><b>The crew has confirmed the trial is finished</b> — ${personHTML(iso.trialRun.completedBy.name, iso.trialRun.completedBy)} · ${fmt(iso.trialRun.completedAt)}.${iso.trialRun.completionRemarks ? " " + esc(iso.trialRun.completionRemarks) : ""} <b>Re-apply the locks.</b></div>` : ""}</div>` : ""}
    ${trialHolds && !energised ? `<div class="warn-box"><b>A trial run is ${trialAt === "approved" ? "authorised" : "requested"} on this certificate.</b>
      Hand-back is held until it is finished or called off — <b>the locks are still ON</b>.</div>` : ""}
    ${iso.status === "assigned" ? `<div class="warn-box">Awaiting confirmation by <b>${personHTML(iso.assignedTo?.name, iso.assignedTo)}</b>. Work must not start until the isolation is confirmed.</div>` : ""}
    ${readyForDeiso ? `<div class="warn-box"><b>Ready for de-isolation.</b> All permits on this certificate have been confirmed work-complete, so <b>${esc(iso.equipmentTag)}</b> can now be de-isolated. <b>Locks are still ON</b> — an Isolator must confirm de-isolation before the Issuer can close the permit(s).</div>` : ""}
    ${iso.status === "removalPending" ? `<div class="warn-box">De-isolation assigned to <b>${iso.removalAssignedTo ? personHTML(iso.removalAssignedTo.name, iso.removalAssignedTo) : "(unassigned — any Isolator can action)"}</b>. Locks are still ON.</div>` : ""}
    ${canRelease ? `<div class="warn-box">This certificate is still <b>active</b> but has <b>no open permits</b>. As Issuer/Admin you can release it to return <b>${esc(iso.equipmentTag)}</b> to service.</div>` : ""}
    <div class="cols cols-2">
      <div class="card"><h3>Certificate</h3>
        ${kv("Equipment", `<span class="mono">${esc(iso.equipmentTag)}</span>${equip ? " · " + esc(equip.line) + " / " + esc(equip.area) : ""}`)}
        ${kv("Created", iso.createdBy ? personHTML(iso.createdBy, iso.createdByMeta) + " · " + fmt(iso.createdAt) : "—")}
        ${kv("Assigned to", iso.assignedTo ? personHTML(iso.assignedTo.name, iso.assignedTo) + " · " + fmt(iso.assignedAt) : "—")}
        ${kv("Isolation confirmed", iso.confirmedBy ? personHTML(iso.confirmedBy.name, iso.confirmedBy) + " · " + fmt(iso.confirmedAt) : "—")}
        ${iso.removalAssignedTo ? kv("De-isolation assigned", personHTML(iso.removalAssignedTo.name, iso.removalAssignedTo) + " · " + fmt(iso.removalAssignedAt)) : ""}
        ${kv("De-isolation confirmed", iso.removalConfirmedBy ? personHTML(iso.removalConfirmedBy.name, iso.removalConfirmedBy) + " · " + fmt(iso.removedAt) : "—")}
      </div>
      <div class="card"><h3>Attached permits</h3>
        <div class="attached-list">${attached.map((p) => `<div class="a" data-pl="${p.id}" style="cursor:pointer"><span class="mono">${esc(p.permitNo)}</span> ${esc(p.typeName)} ${badge(p.status)}</div>`).join("") || "<div class='help'>None</div>"}</div>
      </div>
    </div>
    <div class="card"><h3>Isolation points</h3>
      <table class="tbl"><thead><tr><th>Point</th><th>Method</th><th>Lock / tag</th></tr></thead><tbody>
        ${(iso.points || []).map((i) => `<tr><td>${esc(i.point)}</td><td>${esc(i.method || "—")}</td><td>${esc(i.lockTag || "—")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No points listed</td></tr>`}
      </tbody></table></div>
    ${trialLiveHTML(iso, attached)}
    ${trialHistoryHTML(iso, null)}`;

  $$("[data-pl]").forEach((d) => d.onclick = () => go("detail", { id: d.dataset.pl }));
  $("#ipdf").onclick = () => printIsolation(iso, equip, attached);

  /* ---- trial run, from the certificate ---- */
  // Requesting and clearing are deliberately NOT here. Those are a crew's word
  // about their own people, and they belong on that crew's own permit.
  const itag = esc(iso.equipmentTag || "the equipment");
  const iTrialArgs = { isoId: id, knownIds: attached.map((p) => p.id) };
  const runITrial = async (fn, args, okMsg, errMsg) => {
    try { await fn({ ...iTrialArgs, ...args }); } catch (e) { return toast(e.message || errMsg, "err"); }
    closeModal(); toast(okMsg, "ok"); go("isodetail", { id });
  };

  if (canAuthorise) $("#itrialOk").onclick = () => confirmBoxHTML("Authorise trial run",
    `<div class="danger-box">Authorising permits an Isolator to <b>remove the locks and energise ${itag}</b>.</div>
     <div class="info-box">Requested by ${personHTML(iso.trialRun.requestedBy?.name, iso.trialRun.requestedBy)}${iso.trialRun.reason ? ` — ${esc(iso.trialRun.reason)}` : ""}.
       All ${trialC.given.length} other crew(s) on this certificate have cleared.</div>
     <p>The equipment stays isolated until an Isolator acts.</p>`,
    "Authorise trial run",
    () => runITrial(trialApprove, {}, "Trial run authorised — an Isolator must now de-isolate", "Could not authorise the trial run"), true);

  if (canEnergise) $("#itrialGo").onclick = () => {
    const working = attached.filter((p) => ["active", "extended"].includes(p.status));
    modal({ title: "De-isolate for trial run", wide: true, body: `
      <div class="danger-box">This removes the locks and <b>ENERGISES ${itag}</b>. Every crew must be clear before you proceed.</div>
      <div class="info-box">Authorised by ${personHTML(iso.trialRun.issuerApproval?.name, iso.trialRun.issuerApproval)} · ${fmt(iso.trialRun.issuerApproval?.at)}${iso.trialRun.reason ? ` — ${esc(iso.trialRun.reason)}` : ""}.
        ${working.length ? `<div style="margin-top:.35rem"><b>${working.length} live permit(s)</b> on this certificate: ${working.map((p) => `<span class="mono">${esc(p.permitNo)}</span>`).join(", ")}.</div>` : ""}</div>
      <label class="checkline"><input type="checkbox" id="ig1"> I have verified every crew is physically clear of the equipment</label>
      <label class="checkline"><input type="checkbox" id="ig2"> All crews on this equipment have been notified</label>
      <label class="checkline"><input type="checkbox" id="ig3"> I am removing the locks and tags for the trial run</label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>Remove locks & energise</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => {
      if (!($("#ig1").checked && $("#ig2").checked && $("#ig3").checked)) return toast("Confirm all three checks", "err");
      runITrial(trialEnergise, {}, "Trial run started — equipment ENERGISED", "Could not energise the equipment");
    };
  };

  if (canReIsolate) $("#itrialBack").onclick = () => reIsolateDialog(iso.equipmentTag || "The equipment",
    iso.trialRun, () => runITrial(trialReIsolate, {}, "Re-isolated — work may resume", "Could not re-isolate"));

  if (canCancelTrial) $("#itrialCancel").onclick = () => {
    modal({ title: "Cancel trial run", body: `
      <div class="info-box">The request is withdrawn and kept in the log. Nothing has been energised.</div>
      <label class="lbl">Reason (optional)</label><input id="iCx" placeholder="e.g. no longer needed">`,
      footer: `<button class="btn btn-ghost" data-c>Keep it</button><button class="btn btn-danger" data-ok>Cancel trial run</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = () => runITrial(trialCancel, { reason: $("#iCx").value.trim() },
      "Trial run cancelled", "Could not cancel the trial run");
  };

  if (canConfirm) $("#conf").onclick = () => {
    modal({ title: "Confirm isolation applied", wide: true, body: `
      <div class="info-box">Verify each point and enter the lock/tag number used, then confirm. Attached permits in \u201CAwaiting Isolation\u201D become Active automatically.</div>
      ${(iso.points || []).map((pt, i) => `<div class="iso-row"><input value="${esc(pt.point)}" disabled><input value="${esc(pt.method || "")}" disabled><input data-lk="${i}" placeholder="Lock / tag no." value="${esc(pt.lockTag || "")}"></div>`).join("") || "<div class='help'>No points were listed on the permit.</div>"}
      <label class="checkline" style="margin-top:.6rem"><input type="checkbox" id="ckAll"> I confirm all listed points are isolated, locked and tagged, and zero energy has been verified.</label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Confirm isolation</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = async () => {
      if (!$("#ckAll").checked) return toast("Tick the confirmation statement", "err");
      const pts = (iso.points || []).map((pt, i) => ({ ...pt, lockTag: $(`[data-lk="${i}"]`)?.value.trim() || pt.lockTag || "" }));
      try {
        await lifecycleTx("isolation confirmation", async (tx) => {
          const isoRef = doc(db, "isolations", id);
          const iSnap = await tx.get(isoRef);
          if (!iSnap.exists()) gate("This certificate no longer exists.");
          const cur = iSnap.data();
          // Signing that locks are ON is the one-way step of the whole system —
          // re-read it here so two Isolators cannot both sign the same one, and
          // so a certificate cancelled meanwhile cannot be revived.
          if (cur.status !== "assigned")
            gate(`This certificate is now ${STATUS_LABEL[cur.status] || cur.status} — the isolation was not confirmed again.`);
          // Read every attached permit before writing anything.
          const attachedIds = cur.attachedPermitIds || [];
          const pSnaps = await Promise.all(attachedIds.map((pid) => tx.get(doc(db, "permits", pid))));

          tx.update(isoRef, { points: pts, status: "active", confirmedBy: { uid: me, name: State.profile.name, ...myMeta() }, confirmedAt: nowISO() });
          if (equip) tx.update(doc(db, "equipment", equip.id), { isolationStatus: "isolated", updatedAt: nowISO() });
          pSnaps.forEach((s, i) => {
            if (s.exists() && s.data().status === "awaitingIsolation")
              tx.update(doc(db, "permits", attachedIds[i]), { status: "active", updatedAt: nowISO() });
          });
        });
        closeModal(); toast("Isolation confirmed — waiting permits activated", "ok"); go("isodetail", { id });
      } catch (e) { toast(e.message || "Could not confirm isolation", "err"); }
    };
  };

  if (canRemove) $("#rem").onclick = () => confirmBoxHTML("Confirm de-isolation",
    `<p>All locks and tags have been removed from <b>${esc(iso.equipmentTag)}</b>? The equipment returns to <b>Available</b>.</p>`,
    "Confirm de-isolation", async () => {
      await lifecycleTx("de-isolation", async (tx) => {
        const isoRef = doc(db, "isolations", id);
        const iSnap = await tx.get(isoRef);
        if (!iSnap.exists()) gate("This certificate no longer exists.");
        const cur = iSnap.data();
        if (cur.status === "removed") gate("This certificate has already been de-isolated.");
        const deisoHold = handbackHold(cur, "de-isolating");
        if (deisoHold) gate(deisoHold);
        // Only reset the equipment if THIS certificate is still its current one —
        // never mark it Available out from under a newer certificate. Re-read it
        // inside the transaction so the check cannot be beaten by a stale page.
        const eqRef = equip ? doc(db, "equipment", equip.id) : null;
        const eqSnap = eqRef ? await tx.get(eqRef) : null;
        tx.update(isoRef, { status: "removed", removedAt: nowISO(), removalConfirmedBy: { uid: me, name: State.profile.name, ...myMeta() } });
        if (eqSnap && eqSnap.exists() && eqSnap.data().activeIsolationId === id)
          tx.update(eqRef, { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
      });
      closeModal(); toast("De-isolation confirmed — equipment available", "ok"); go("isodetail", { id });
    });

  if (canRelease) $("#release").onclick = () => confirmBoxHTML("Release isolation",
    `<p>This certificate has <b>no open permits</b>. Confirm all locks and tags are removed from <b>${esc(iso.equipmentTag)}</b> and return it to <b>Available</b>?</p>`,
    "Release isolation", async () => {
      await lifecycleTx("release", async (tx) => {
        const isoRef = doc(db, "isolations", id);
        const iSnap = await tx.get(isoRef);
        if (!iSnap.exists()) gate("This certificate no longer exists.");
        const cur = iSnap.data();
        if (cur.status !== "active") gate(`This certificate is now ${STATUS_LABEL[cur.status] || cur.status} — it was not released.`);
        const relHold = handbackHold(cur, "releasing");
        if (relHold) gate(relHold);
        // "No open permits" is what makes releasing safe. A permit may have been
        // approved onto this certificate while the dialog was open, so re-check
        // every attachment server-side rather than trusting the loaded page.
        const attachedIds = cur.attachedPermitIds || [];
        const pSnaps = await Promise.all(attachedIds.map((pid) => tx.get(doc(db, "permits", pid))));
        const stillOpen = pSnaps.filter((s) => s.exists() &&
          ["draft", "submitted", "awaitingIsolation", "active", "extended"].includes(s.data().status)).length;
        if (stillOpen) gate(`${stillOpen} permit(s) are now attached to this certificate — it can no longer be released.`);
        const eqRef = equip ? doc(db, "equipment", equip.id) : null;
        const eqSnap = eqRef ? await tx.get(eqRef) : null;
        tx.update(isoRef, { attachedPermitIds: [], status: "removed", removedAt: nowISO(), removalConfirmedBy: { uid: me, name: State.profile.name, ...myMeta() }, removalNote: "Released by Issuer/Admin — no open permits" });
        if (eqSnap && eqSnap.exists() && eqSnap.data().activeIsolationId === id)
          tx.update(eqRef, { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
      });
      closeModal(); toast("Isolation released — equipment available", "ok"); go("isodetail", { id });
    }, true);
}

// Trial runs on the printed record. A printed certificate is read as evidence,
// so this answers the two questions an investigation asks: who authorised the
// equipment being energised, and who put the locks back.
function trialPrintHTML(iso, permit) {
  const all = trialRecords(iso, permit);
  if (!all.length) return "";
  const cell = (v) => `<td style="padding:5px;border-top:1px solid #eee">${v}</td>`;
  return `<div style="margin-top:12px;font-weight:800;color:#2A6F97;font-size:13px">TRIAL RUNS</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #ccc">
      <tr style="background:#f2f5f8"><th style="text-align:left;padding:5px">Requested</th>
        <th style="text-align:left;padding:5px">Authorised by</th>
        <th style="text-align:left;padding:5px">Locks out</th>
        <th style="text-align:left;padding:5px">Locks back</th>
        <th style="text-align:left;padding:5px">Outcome</th></tr>
      ${all.map((t) => `<tr>
        ${cell(fmt(t.requestedAt) + (t.permitNo ? "<br>" + esc(t.permitNo) : "") + (t.reason ? "<br>" + esc(t.reason) : ""))}
        ${cell(t.issuerApproval ? personHTML(t.issuerApproval.name, t.issuerApproval) + "<br>" + fmt(t.issuerApproval.at)
              // The earlier flow had no separate authorisation step — the one
              // person who started the trial authorised it, and is recorded as
              // its requester. Dropping them would leave the print with nobody
              // named against an energisation that did happen.
              : t.legacy && t.requestedBy?.name ? personHTML(t.requestedBy.name, t.requestedBy) : "—")}
        ${cell(t.deisolatedBy ? personHTML(t.deisolatedBy.name, t.deisolatedBy) + "<br>" + fmt(t.deisolatedAt) : "—")}
        ${cell(t.reIsolatedBy ? personHTML(t.reIsolatedBy.name, t.reIsolatedBy) + "<br>" + fmt(t.reIsolatedAt)
              : t.reIsolatedAt ? fmt(t.reIsolatedAt) : "<b>NOT RE-ISOLATED</b>")}
        ${cell((t.outcome ? esc(t.outcome.toUpperCase()) : "OPEN") +
               (t.completedBy ? "<br>crew confirmed finished" : t.outcome === "completed" && !t.legacy && t.reIsolatedBy ? "<br>cut short" : "") +
               (t.legacy ? "<br>earlier flow" : ""))}
      </tr>`).join("")}
    </table>`;
}

function printIsolation(iso, equip, attached) {
  const row = (k, v) => `<tr><td style="padding:4px 10px;color:#555;width:190px">${k}</td><td style="padding:4px 10px;font-weight:600">${v}</td></tr>`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#15293B;max-width:760px;margin:0 auto;padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #0E2A47;padding-bottom:10px">
        <div><div style="font-size:20px;font-weight:800">ISOLATION CERTIFICATE</div>
          <div style="color:#666">${esc(appBranding.company)} · ${esc(appBranding.site)}</div></div>
        <div style="text-align:right"><div style="font-size:18px;font-weight:800;color:#0E2A47">${esc(iso.isoNo || iso.id)}</div>
          <div style="color:#666">Status: ${esc(iso.status.toUpperCase())}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:14px">
        ${row("Equipment", esc(iso.equipmentTag) + (equip ? " · " + esc(equip.line) + " / " + esc(equip.area) : ""))}
        ${row("Created by", iso.createdBy ? personHTML(iso.createdBy, iso.createdByMeta) + " · " + fmt(iso.createdAt) : "—")}
        ${row("Assigned to", iso.assignedTo ? personHTML(iso.assignedTo.name, iso.assignedTo) + " · " + fmt(iso.assignedAt) : "—")}
        ${row("Isolation confirmed", iso.confirmedBy ? personHTML(iso.confirmedBy.name, iso.confirmedBy) + " · " + fmt(iso.confirmedAt) : "—")}
        ${iso.removalAssignedTo ? row("De-isolation assigned", personHTML(iso.removalAssignedTo.name, iso.removalAssignedTo) + " · " + fmt(iso.removalAssignedAt)) : ""}
        ${row("De-isolation confirmed", iso.removalConfirmedBy ? personHTML(iso.removalConfirmedBy.name, iso.removalConfirmedBy) + " · " + fmt(iso.removedAt) : "—")}
      </table>
      <div style="margin-top:14px;font-weight:800;color:#2A6F97;font-size:13px">ISOLATION POINTS</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #ccc"><tr style="background:#f2f5f8"><th style="text-align:left;padding:5px">Point</th><th style="text-align:left;padding:5px">Method</th><th style="text-align:left;padding:5px">Lock/Tag</th></tr>
      ${(iso.points || []).map((i) => `<tr><td style="padding:5px;border-top:1px solid #eee">${esc(i.point)}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.method || "")}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.lockTag || "")}</td></tr>`).join("") || `<tr><td colspan="3" style="padding:6px">No points listed</td></tr>`}</table>
      <div style="margin-top:12px;font-weight:800;color:#2A6F97;font-size:13px">ATTACHED PERMITS</div>
      <div>${(attached || []).map((p) => esc(p.permitNo) + " (" + esc(p.status) + ")").join(" · ") || "—"}</div>
      ${trialPrintHTML(iso, null)}
      <div style="margin-top:40px;display:flex;justify-content:space-between;gap:14px">
        <div style="border-top:1px solid #333;width:31%;padding-top:5px;font-size:12px">Assigned by (Issuer)</div>
        <div style="border-top:1px solid #333;width:31%;padding-top:5px;font-size:12px">Isolated by</div>
        <div style="border-top:1px solid #333;width:31%;padding-top:5px;font-size:12px">De-isolated by</div>
      </div>
      <div style="margin-top:20px;color:#999;font-size:11px">Generated ${fmt(nowISO())} · NRCC Work Permit System</div>
    </div>`;
  $("#print-area").innerHTML = html;
  window.print();
}

/* expose for inline handlers if any */
window.go = go;
