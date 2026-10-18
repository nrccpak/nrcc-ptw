/* Admin force-close: the three-step override (work complete → de-isolation →
   close), run against a simulated Firestore transaction so what is asserted is
   the code that ships.

   What matters here is not that the happy path writes the right fields but that
   the override REFUSES when it must:
     - only an Admin can ask, and only an Issuer (never the same person) decides
     - nothing happens at request time; approval is what performs the action
     - the 10-day wait is measured from the permit's last activity, and the
       clock does not restart between the three steps
     - a reason, a category and the whole checklist are mandatory
     - the steps go in order, and de-isolation waits for the other crews on a
       shared lockout, and never touches a lockout that is energised for a trial
     - one request at a time; a stale request cannot be carried out

   Run: node tests/force-close.mjs                                           */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

function grab(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("not found in app.js: " + sig);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") { d++; started = true; }
    else if (src[j] === "}") { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced: " + sig);
}
// For a signature whose parameter list itself contains braces: the function
// ends at the first closing brace in column 0.
function grabTop(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("not found in app.js: " + sig);
  return src.slice(i, src.indexOf("\n}\n", i) + 2);
}
const STATUS_LABEL_SRC = src.slice(src.indexOf("const STATUS_LABEL ="),
  src.indexOf(";", src.indexOf('removed: "Removed"')) + 1);
// The constants, as one contiguous block ending after forceChecklist().
const FORCE_CONSTS = src.slice(src.indexOf("const FORCE_MIN_WAIT_DAYS"),
  src.indexOf("function forceLastActivity"));

const mod = new Function("docStub", `
  const doc = docStub, db = {};
  ${STATUS_LABEL_SRC}
  ${FORCE_CONSTS}
  ${grab("class GateError extends Error")}
  ${grab("function gate(msg)")}
  ${grab("function trialStage(iso)")}
  ${grab("function isTrialEnergised(iso)")}
  ${grab("function handbackHold(iso, verb)")}
  ${grab("function isoReadyForDeiso(iso, permits, byIso)")}
  ${grab("async function txReadCrew(tx, isoId, isoData, knownIds)")}
  ${grab("function forceLastActivity(p, iso)")}
  ${grab("function forceAnchorMs(p, iso)")}
  ${grab("function forceWait(p, iso, nowMs)")}
  ${grabTop("function forceGate(")}
  ${grab("async function txForceRequest(tx, o)")}
  ${grab("async function txForceDecide(tx, o)")}
  ${grab("async function txForceWithdraw(tx, o)")}
  return { GateError, FORCE_MIN_WAIT_DAYS, forceChecklist, forceGate, forceWait, forceLastActivity,
           txForceRequest, txForceDecide, txForceWithdraw };
`)((_db, coll, id) => ({ coll, id }));
const { GateError, FORCE_MIN_WAIT_DAYS, forceChecklist, forceGate, forceWait,
  txForceRequest, txForceDecide, txForceWithdraw } = mod;

/* --- simulated transaction: reads a plain store, records every write --- */
const mkTx = (s) => {
  const writes = [];
  return {
    writes,
    get: async (ref) => {
      if (writes.length) throw new Error("read after write: " + ref.coll + "/" + ref.id);
      const d = s[ref.coll]?.[ref.id];
      return { exists: () => !!d, data: () => d, id: ref.id };
    },
    update: (ref, data) => writes.push({ op: "update", coll: ref.coll, id: ref.id, data }),
    set: (ref, data) => writes.push({ op: "set", coll: ref.coll, id: ref.id, data })
  };
};
const wrote = (tx, coll, id) =>
  tx.writes.filter((w) => w.coll === coll && w.id === id).reduce((a, w) => ({ ...a, ...w.data }), null);

const DAY = 86400000;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");        // the permit's last activity
const iso8 = (ms) => new Date(ms).toISOString();
const LATER = T0 + 11 * DAY;                               // past the waiting period
const SOON = T0 + 3 * DAY;                                 // not yet

const who = (uid, role) => ({ uid, name: uid, role, jobTitle: "", department: "", employeeNumber: "" });
const ADMIN = who("u-adm", "admin"), ISSUER = who("u-iss", "issuer"), ISSUER2 = who("u-iss2", "issuer");
const REQ = who("u-req", "requester"), ISOLATOR = who("u-iso", "isolator");

const permit = (id, over = {}) => ({
  permitNo: "PTW-" + id, status: "active", equipmentRef: "EQ1", equipmentTag: "P-101A", isolationRef: "C1",
  requester: { uid: "u-" + id, name: id }, approval: { issuerUid: "u-iss", issuerName: "u-iss", timestamp: iso8(T0) },
  createdAt: iso8(T0), updatedAt: iso8(T0), ...over
});
const DONE = { by: "u-A", name: "A", timestamp: iso8(T0), safeToReturn: true };
const store = (over = {}) => ({
  permits: { A: permit("A"), ...(over.permits || {}) },
  equipment: { EQ1: { tag: "P-101A", isolationStatus: "isolated", activeIsolationId: "C1" } },
  isolations: { C1: { status: "active", equipmentTag: "P-101A", attachedPermitIds: ["A"], confirmedAt: iso8(T0), ...(over.iso || {}) } },
  forceRequests: over.forceRequests || {}
});
const CHECKS = forceChecklist("workComplete");
const REASON = "Requester left site; nobody else can sign off the job";
const reqArgs = (action, over = {}) => ({
  id: "R1", permitId: "A", action, category: "unavailable", reason: REASON,
  checks: forceChecklist(action), actor: ADMIN, at: iso8(LATER), nowMs: LATER, knownIds: ["A"], ...over
});
const decArgs = (decision, over = {}) => ({
  requestId: "R1", decision, comment: "", actor: ISSUER, at: iso8(LATER), nowMs: LATER, knownIds: ["A"], ...over
});

let pass = 0, fail = 0;
async function check(name, fn, expect) {
  // A plain boolean is an assertion about something already computed.
  if (typeof fn !== "function") { fn ? pass++ : fail++; console.log(`${fn ? "  PASS" : "  FAIL"}  ${name}`); return; }
  let got = "ok", tx = null;
  try { tx = await fn(); } catch (e) { got = e instanceof GateError ? "gate:" + e.message : "ERR:" + e.message; }
  const ok = expect === "ok" ? got === "ok" : typeof expect === "string" ? got.includes(expect) : false;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : `\n        wanted ${expect}\n        got    ${got}`}`);
  return tx;
}
const run = async (core, s, o) => { const tx = mkTx(s); await core(tx, o); return tx; };

console.log("\nThe waiting period:");
{
  const p = permit("A"), i = { id: "C1", status: "active" };
  const w = forceWait(p, i, SOON);
  check("3 days after last activity is not enough", w.ok === false && Math.ceil(w.msLeft / DAY) === FORCE_MIN_WAIT_DAYS - 3);
  check("11 days after is", forceWait(p, i, LATER).ok === true);
  check("exactly 10 days is", forceWait(p, i, T0 + 10 * DAY).ok === true);
  check("a permit with no dates at all cannot prove it has waited", forceWait({ status: "active" }, null, LATER).ok === false);
  const recent = permit("A", { updatedAt: iso8(T0 + 9 * DAY) });
  check("recent activity on the permit restarts the wait", forceWait(recent, i, T0 + 12 * DAY).ok === false);
  check("so does recent activity on the lockout (a trial run)",
    forceWait(p, { id: "C1", trialRun: { deisolatedAt: iso8(T0 + 9 * DAY) } }, T0 + 12 * DAY).ok === false);
  const anchored = permit("A", { force: { anchorMs: T0 }, updatedAt: iso8(T0 + 11 * DAY) });
  check("a fixed anchor beats later writes — the chain's steps don't each restart the clock", forceWait(anchored, i, LATER).ok === true);
}

console.log("\nRaising a request:");
{
  const tx = await check("Admin can ask to force work-complete", () => run(txForceRequest, store(), reqArgs("workComplete")), "ok");
  const r = wrote(tx, "forceRequests", "R1"), p = wrote(tx, "permits", "A");
  check("the request records who, why, the checklist and the original people",
    r.status === "pending" && r.reason === REASON && r.requestedBy.uid === "u-adm" && r.checks.length === 4
    && r.permitRequesterUid === "u-A" && r.permitIssuerUid === "u-iss" && r.decision === null);
  check("the permit is only FLAGGED — status and completion are untouched",
    p.forcePending.requestId === "R1" && p.status === undefined && p.workCompletion === undefined && p.closure === undefined);
  check("the clock's anchor is fixed on the permit and on the request", p["force.anchorMs"] === T0 && r.anchorMs === T0);
}
check("an Issuer cannot raise one", () => run(txForceRequest, store(), reqArgs("workComplete", { actor: ISSUER })), "Only an Administrator");
check("nor can a requester", () => run(txForceRequest, store(), reqArgs("workComplete", { actor: REQ })), "Only an Administrator");
check("too soon is refused", () => run(txForceRequest, store(), reqArgs("workComplete", { nowMs: SOON })), "Too soon");
check("no category is refused", () => run(txForceRequest, store(), reqArgs("workComplete", { category: "" })), "category");
check("a made-up category is refused", () => run(txForceRequest, store(), reqArgs("workComplete", { category: "boredom" })), "category");
check("a short reason is refused", () => run(txForceRequest, store(), reqArgs("workComplete", { reason: "no one here" })), "written reason");
check("an unticked checklist item is refused",
  () => run(txForceRequest, store(), reqArgs("workComplete", { checks: CHECKS.slice(1) })), "checklist");
check("de-isolation needs the extra re-energise item",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE }) } }), reqArgs("deisolate", { checks: CHECKS })), "checklist");
check("a second request while one is waiting is refused",
  () => run(txForceRequest, store({ permits: { A: permit("A", { forcePending: { requestId: "R0" } }) } }), reqArgs("workComplete")), "already waiting");
check("a closed permit cannot be forced",
  () => run(txForceRequest, store({ permits: { A: permit("A", { status: "closed" }) } }), reqArgs("workComplete")), "only an active or extended");
check("work-complete twice is refused",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE }) } }), reqArgs("workComplete")), "already on record");

console.log("\nThe steps go in order:");
check("cannot force de-isolation before work is complete", () => run(txForceRequest, store(), reqArgs("deisolate")), "Work must be marked complete");
check("cannot force closure before work is complete", () => run(txForceRequest, store(), reqArgs("close")), "Work must be marked complete");
check("cannot force closure while the locks are on",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE }) } }), reqArgs("close")), "De-isolate the equipment first");
check("can force closure once de-isolated",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE }) }, iso: { status: "removed" } }), reqArgs("close")), "ok");
check("a permit with no isolation closes without the de-isolation step",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE, isolationRef: null }) } }), reqArgs("close")), "ok");
check("a permit with no isolation has nothing to de-isolate",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE, isolationRef: null }) } }), reqArgs("deisolate")), "no isolation");
check("can force de-isolation after work-complete",
  () => run(txForceRequest, store({ permits: { A: permit("A", { workCompletion: DONE }) } }), reqArgs("deisolate")), "ok");

console.log("\nShared lockouts and trial runs:");
{
  const two = (bOver) => store({ permits: { A: permit("A", { workCompletion: DONE }), B: permit("B", bOver) },
    iso: { attachedPermitIds: ["A", "B"] } });
  check("another crew still working holds the de-isolation",
    () => run(txForceRequest, two({}), reqArgs("deisolate", { knownIds: ["A", "B"] })), "not work-complete yet");
  check("…once that crew is also done, it can go",
    () => run(txForceRequest, two({ workCompletion: DONE }), reqArgs("deisolate", { knownIds: ["A", "B"] })), "ok");
  check("…or if the other permit has been closed",
    () => run(txForceRequest, two({ status: "closed" }), reqArgs("deisolate", { knownIds: ["A", "B"] })), "ok");
  const done = { permits: { A: permit("A", { workCompletion: DONE }) } };
  check("equipment energised for a trial cannot be force-de-isolated",
    () => run(txForceRequest, store({ ...done, iso: { status: "trialRun" } }), reqArgs("deisolate")), "energised for a trial");
  check("nor while a trial run is merely in flight",
    () => run(txForceRequest, store({ ...done, iso: { trialRun: { status: "requested" } } }), reqArgs("deisolate")), "trial run is in progress");
}

console.log("\nDeciding — nothing happens until an Issuer approves:");
const pending = (action, extra = {}) => ({
  R1: { permitId: "A", permitNo: "PTW-A", action, category: "unavailable", reason: REASON, checks: forceChecklist(action),
    status: "pending", anchorMs: T0, requestedBy: ADMIN, requestedAt: iso8(LATER), decision: null, ...extra }
});
const withReq = (action, permits = {}, over = {}) => store({
  permits: { A: permit("A", { forcePending: { requestId: "R1", action }, force: { anchorMs: T0 }, ...(permits.A || {}) }), ...(permits.rest || {}) },
  forceRequests: pending(action), ...over
});
{
  const tx = await check("an Issuer approving force work-complete", () => run(txForceDecide, withReq("workComplete"), decArgs("approve")), "ok");
  const p = wrote(tx, "permits", "A"), r = wrote(tx, "forceRequests", "R1");
  check("records work complete, marked FORCED, with both people's names",
    p.workCompletion.forced.requestedBy.uid === "u-adm" && p.workCompletion.forced.approvedBy.by === "u-iss"
    && p.workCompletion.by === "u-adm" && p.workCompletion.safeToReturn === true && /FORCED/.test(p.workCompletion.remarks)
    && p.workCompletion.forced.reason === REASON);
  check("clears the flag and marks the request carried out", p.forcePending === null && r.status === "approved" && r.decision.by === "u-iss" && r.executedAt);
  check("does not close the permit or touch the lockout", p.status === undefined && !tx.writes.some((w) => w.coll === "isolations"));
}
{
  const tx = await check("approving force de-isolation", () => run(txForceDecide,
    withReq("deisolate", { A: { workCompletion: DONE } }), decArgs("approve")), "ok");
  const i = wrote(tx, "isolations", "C1"), e = wrote(tx, "equipment", "EQ1");
  check("removes the lockout, marked FORCED", i.status === "removed" && i.forced.approvedBy.by === "u-iss" && i.removalConfirmedBy.uid === "u-adm");
  check("returns the equipment to service", e.isolationStatus === "available" && e.activeIsolationId === null);
  check("and does not close the permit", wrote(tx, "permits", "A").status === undefined);
}
check("a newer certificate on the equipment is left alone",
  async () => {
    const s = withReq("deisolate", { A: { workCompletion: DONE } });
    s.equipment.EQ1.activeIsolationId = "C2";
    const tx = await run(txForceDecide, s, decArgs("approve"));
    if (wrote(tx, "equipment", "EQ1")) throw new Error("equipment was reset");
  }, "ok");
{
  const tx = await check("approving force close", () => run(txForceDecide,
    withReq("close", { A: { workCompletion: DONE } }, { iso: { status: "removed" } }), decArgs("approve")), "ok");
  const p = wrote(tx, "permits", "A");
  check("closes the permit with a FORCED closure naming both people",
    p.status === "closed" && p.closure.forced.requestedBy.uid === "u-adm" && p.closure.forced.approvedBy.by === "u-iss" && p.forcePending === null);
}

console.log("\nWho may decide:");
check("the Admin cannot approve their own request", () => run(txForceDecide, withReq("workComplete"), decArgs("approve", { actor: ADMIN })), "Only an Issuer");
check("an Admin who is also named on it still cannot", () => run(txForceDecide, withReq("workComplete"), decArgs("approve", { actor: { ...ADMIN, role: "issuer" } })), "your own request");
check("a requester cannot", () => run(txForceDecide, withReq("workComplete"), decArgs("approve", { actor: REQ })), "Only an Issuer");
check("an isolator cannot", () => run(txForceDecide, withReq("workComplete"), decArgs("approve", { actor: ISOLATOR })), "Only an Issuer");
check("any other Issuer can", () => run(txForceDecide, withReq("workComplete"), decArgs("approve", { actor: ISSUER2 })), "ok");

console.log("\nRejecting:");
{
  const tx = await check("an Issuer can reject with a reason", () => run(txForceDecide, withReq("workComplete"), decArgs("reject", { comment: "Requester is back on site" })), "ok");
  const p = wrote(tx, "permits", "A"), r = wrote(tx, "forceRequests", "R1");
  check("the request is rejected, the flag cleared and the permit otherwise untouched",
    r.status === "rejected" && r.decision.comment && p.forcePending === null && p.workCompletion === undefined && p.status === undefined);
}
check("rejecting without a reason is refused", () => run(txForceDecide, withReq("workComplete"), decArgs("reject")), "reason for rejecting");
check("an unknown decision is refused", () => run(txForceDecide, withReq("workComplete"), decArgs("maybe")), "Unrecognised decision");

console.log("\nStale requests are not carried out:");
check("a request already decided cannot be decided again",
  () => run(txForceDecide, withReq("workComplete", {}, { forceRequests: pending("workComplete", { status: "approved" }) }), decArgs("approve")), "already approved");
check("a request that is no longer the permit's pending one is refused",
  () => run(txForceDecide, withReq("workComplete", { A: { forcePending: { requestId: "R9" } } }), decArgs("approve")), "no longer the pending");
check("approval re-runs the gates: the requester finished the job meanwhile",
  () => run(txForceDecide, withReq("workComplete", { A: { workCompletion: DONE } }), decArgs("approve")), "already on record");
check("…or the permit was closed meanwhile",
  () => run(txForceDecide, withReq("workComplete", { A: { status: "closed" } }), decArgs("approve")), "only an active or extended");
check("…or a trial run started meanwhile",
  () => run(txForceDecide, withReq("deisolate", { A: { workCompletion: DONE } }, { iso: { status: "trialRun" } }), decArgs("approve")), "energised for a trial");
check("…or another crew was attached to the lockout meanwhile",
  () => run(txForceDecide, withReq("deisolate", { A: { workCompletion: DONE }, rest: { B: permit("B") } }, { iso: { attachedPermitIds: ["A", "B"] } }),
    decArgs("approve", { knownIds: ["A", "B"] })), "not work-complete yet");
check("approval honours the request's own anchor even if the permit's flag was lost",
  () => run(txForceDecide, withReq("workComplete", { A: { force: undefined, updatedAt: iso8(T0) } }, { forceRequests: pending("workComplete", { anchorMs: LATER - DAY }) }), decArgs("approve")), "Too soon");

console.log("\nWithdrawing:");
{
  const tx = await check("the Admin can withdraw their own request", () => run(txForceWithdraw, withReq("workComplete"), { requestId: "R1", actor: ADMIN }), "ok");
  check("which voids it and clears the flag", wrote(tx, "forceRequests", "R1").status === "void" && wrote(tx, "permits", "A").forcePending === null);
}
check("another Admin cannot withdraw it", () => run(txForceWithdraw, withReq("workComplete"), { requestId: "R1", actor: { ...ADMIN, uid: "u-adm2" } }), "who raised");
check("an Issuer cannot withdraw it", () => run(txForceWithdraw, withReq("workComplete"), { requestId: "R1", actor: ISSUER }), "who raised");
check("a decided request cannot be withdrawn",
  () => run(txForceWithdraw, withReq("workComplete", {}, { forceRequests: pending("workComplete", { status: "approved" }) }), { requestId: "R1", actor: ADMIN }), "already approved");

console.log("\nEvery transaction reads before it writes:");
for (const [name, core, s, o] of [
  ["request", txForceRequest, store(), reqArgs("workComplete")],
  ["approval", txForceDecide, withReq("deisolate", { A: { workCompletion: DONE } }), decArgs("approve")],
  ["rejection", txForceDecide, withReq("workComplete"), decArgs("reject", { comment: "no" })],
  ["withdrawal", txForceWithdraw, withReq("workComplete"), { requestId: "R1", actor: ADMIN }]
]) await check(`${name} (a read after a write would throw in the simulator)`, () => run(core, s, o), "ok");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
