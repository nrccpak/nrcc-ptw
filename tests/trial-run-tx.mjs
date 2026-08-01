/* The trial-run lifecycle writes, run against a simulated Firestore
   transaction so the assertions exercise shipped code rather than a copy.

   These six transactions are the only path by which this app energises
   equipment that crews are holding permits on, so what is checked here is not
   "does it write the right field" but "does it refuse when it must":

     - the crew asks, the Issuer authorises, the ISOLATOR energises. No role
       may do another's step, and authorisation is never the act itself.
     - one refusal ends the request; nobody overrules a crew.
     - readiness is recomputed inside the transaction from the permits it read
       itself, so a crew attached to the lockout after the consents were
       gathered stops the trial instead of being energised around.
     - a certificate energised by the FIRST version of this feature — status
       trialRun, no sub-document, the record stranded on one permit — must
       still be re-isolatable, and its stranded entry gets closed.

   Run: node tests/trial-run-tx.mjs                                          */
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
const STATUS_LABEL_SRC = src.slice(src.indexOf("const STATUS_LABEL ="),
  src.indexOf(";", src.indexOf('removed: "Removed"')) + 1);

const mod = new Function("docStub", "arrayUnionStub", `
  const doc = docStub, db = {}, arrayUnion = arrayUnionStub;
  ${STATUS_LABEL_SRC}
  ${grab("class GateError extends Error")}
  ${grab("function gate(msg)")}
  ${grab("function trialStage(iso)")}
  ${grab("function isTrialEnergised(iso)")}
  ${grab("function trialConsentTargets(iso, permits, requestingPermitId)")}
  ${grab("function trialConsentState(iso, permits)")}
  ${grab("function trialReadyToEnergise(iso, permits)")}
  ${grab("async function txReadCrew(tx, isoId, isoData, knownIds)")}
  ${grab("async function txTrialRequest(tx, o)")}
  ${grab("async function txTrialAnswer(tx, o)")}
  ${grab("async function txTrialApprove(tx, o)")}
  ${grab("async function txTrialCancel(tx, o)")}
  ${grab("async function txTrialEnergise(tx, o)")}
  ${grab("async function txTrialReIsolate(tx, o)")}
  return { GateError, txReadCrew, txTrialRequest, txTrialAnswer, txTrialApprove,
           txTrialCancel, txTrialEnergise, txTrialReIsolate };
`)((_db, coll, id) => ({ coll, id }), (...v) => ({ __arrayUnion: v }));

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
    update: (ref, data) => writes.push({ coll: ref.coll, id: ref.id, data })
  };
};
const wrote = (tx, coll, id) =>
  tx.writes.filter((w) => w.coll === coll && w.id === id).reduce((a, w) => ({ ...a, ...w.data }), null);
const unioned = (v) => (v && v.__arrayUnion ? v.__arrayUnion[0] : undefined);

const AT = "2026-08-01T09:00:00.000Z";
const NOW = "2026-08-01T11:30:00.000Z";
const who = (uid, role) => ({ uid, name: uid, role, jobTitle: "", department: "", employeeNumber: "" });
const REQ_A = who("u-A", "requester"), REQ_B = who("u-B", "requester"), REQ_C = who("u-C", "requester");
const ISSUER = who("u-iss", "issuer"), ISOLATOR = who("u-iso", "isolator"), ADMIN = who("u-adm", "admin");

const permit = (id, over = {}) => ({
  permitNo: "PTW-" + id, status: "active", equipmentRef: "EQ1", isolationRef: "C1",
  requester: { uid: "u-" + id, name: id }, ...over
});
const says = (id, decision) => ({ permitId: id, uid: "u-" + id, decision, at: AT });
const trial = (status, consents = [], over = {}) => ({
  status, permitId: "A", permitNo: "PTW-A", reason: "prove the seal",
  requestedBy: REQ_A, requestedAt: AT,
  consents: [{ permitId: "A", uid: "u-A", decision: "requested", at: AT }, ...consents],
  issuerApproval: status === "approved" || status === "energised" ? { ...ISSUER, at: AT } : null,
  ...over
});
// Three crews on one lockout: A asks, B and C must clear.
const store = (trialRun = null, over = {}) => ({
  permits: { A: permit("A"), B: permit("B"), C: permit("C") },
  equipment: { EQ1: { tag: "P-101A", isolationStatus: "isolated", activeIsolationId: "C1" } },
  isolations: { C1: { status: "active", equipmentTag: "P-101A",
    attachedPermitIds: ["A", "B", "C"], trialRun, ...over } }
});
const base = { isoId: "C1", equipmentId: "EQ1", at: NOW, knownIds: ["A", "B", "C"] };

let pass = 0, fail = 0;
async function check(name, fn, expect) {
  let got = "ok", tx = null;
  try { tx = await fn(); } catch (e) { got = e instanceof mod.GateError ? "gate" : "error:" + e.message; }
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : `  (expected ${expect}, got ${got})`}`);
  return tx;
}
function is(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }
// Run one transaction core against a fresh store, returning the tx for assertions.
const run = (fn, s, o) => async () => { const tx = mkTx(s); await mod[fn](tx, { ...base, ...o }); return tx; };

/* ===================== 1. Request ===================== */
console.log("\nThe crew doing the work asks — nobody asks on their behalf:");
{
  const s = store();
  const tx = await check("the permit's own requester may ask",
    run("txTrialRequest", s, { permitId: "A", reason: "prove the seal", actor: REQ_A }), "ok");
  const w = wrote(tx, "isolations", "C1");
  is("the request lands on the CERTIFICATE, not the permit", !!w.trialRun && tx.writes.every((x) => x.coll === "isolations"));
  is("it starts as requested, unauthorised", w.trialRun.status === "requested" && w.trialRun.issuerApproval === null);
  is("it records which crew asked", w.trialRun.permitId === "A" && w.trialRun.requestedBy.uid === "u-A");
  is("the asker's own entry is marked 'requested', not a consent",
    w.trialRun.consents.length === 1 && w.trialRun.consents[0].decision === "requested");
}
{
  await check("another crew's requester may not ask for them",
    run("txTrialRequest", store(), { permitId: "A", actor: REQ_B }), "gate");
  await check("an Issuer may not raise the request",
    run("txTrialRequest", store(), { permitId: "A", actor: ISSUER }), "gate");
  await check("an Admin may not raise it either",
    run("txTrialRequest", store(), { permitId: "A", actor: ADMIN }), "gate");
}
{
  const closed = store(); closed.permits.A.status = "closed";
  await check("a permit that is no longer live cannot ask",
    run("txTrialRequest", closed, { permitId: "A", actor: REQ_A }), "gate");
  const detached = store(); detached.permits.A.isolationRef = "C2";
  await check("a permit detached from the certificate cannot ask",
    run("txTrialRequest", detached, { permitId: "A", actor: REQ_A }), "gate");
  for (const st of ["assigned", "removalPending", "removed", "trialRun"])
    await check(`a ${st} certificate cannot take a request`,
      run("txTrialRequest", store(null, { status: st }), { permitId: "A", actor: REQ_A }), "gate");
  await check("a second request while one is in flight refuses",
    run("txTrialRequest", store(trial("requested")), { permitId: "A", actor: REQ_A }), "gate");
}

/* ===================== 2. Consent / refuse ===================== */
console.log("\nEvery other crew on the tools answers for itself:");
{
  const tx = await check("a crew clears the trial",
    run("txTrialAnswer", store(trial("requested")), { permitId: "B", decision: "consent", actor: REQ_B }), "ok");
  const w = wrote(tx, "isolations", "C1");
  is("consent is appended, never a rewritten array", !!w["trialRun.consents"].__arrayUnion);
  is("the entry names the crew and the decision",
    unioned(w["trialRun.consents"]).permitId === "B" && unioned(w["trialRun.consents"]).decision === "consent");
}
{
  await check("a crew cannot answer for another crew",
    run("txTrialAnswer", store(trial("requested")), { permitId: "B", decision: "consent", actor: REQ_C }), "gate");
  await check("an Issuer cannot clear a crew's behalf",
    run("txTrialAnswer", store(trial("requested")), { permitId: "B", decision: "consent", actor: ISSUER }), "gate");
  await check("the asking crew is not asked to consent to itself",
    run("txTrialAnswer", store(trial("requested")), { permitId: "A", decision: "consent", actor: REQ_A }), "gate");
  await check("answering twice refuses",
    run("txTrialAnswer", store(trial("requested", [says("B", "consent")])), { permitId: "B", decision: "consent", actor: REQ_B }), "gate");
  await check("an unrecognised answer records nothing",
    run("txTrialAnswer", store(trial("requested")), { permitId: "B", decision: "maybe", actor: REQ_B }), "gate");
  await check("no answers once the Issuer has authorised",
    run("txTrialAnswer", store(trial("approved")), { permitId: "B", decision: "consent", actor: REQ_B }), "gate");
}
{
  // The rule chosen for this site: a crew that has confirmed work complete has
  // already declared the equipment safe to return to service.
  const s = store(trial("requested"));
  s.permits.B.workCompletion = { timestamp: AT };
  await check("a work-complete crew is not asked, so cannot answer",
    run("txTrialAnswer", s, { permitId: "B", decision: "consent", actor: REQ_B }), "gate");
}
console.log("\nOne refusal ends it — nobody overrules a crew:");
{
  const tx = await check("a crew refuses",
    run("txTrialAnswer", store(trial("requested", [says("B", "consent")])), { permitId: "C", decision: "refuse", actor: REQ_C }), "ok");
  const w = wrote(tx, "isolations", "C1");
  is("the request is cleared from the certificate", w.trialRun === null);
  is("it is kept in the log as refused", unioned(w.trialRunLog).outcome === "refused");
  is("the log keeps who cleared and who refused",
    unioned(w.trialRunLog).consents.map((c) => c.decision).join(",") === "requested,consent,refuse");
}

/* ===================== 3. Issuer authorisation ===================== */
console.log("\nThe Issuer authorises, and only once every crew has cleared:");
{
  const all = [says("B", "consent"), says("C", "consent")];
  const tx = await check("all clear → authorised",
    run("txTrialApprove", store(trial("requested", all)), { actor: ISSUER }), "ok");
  const w = wrote(tx, "isolations", "C1");
  is("the stage moves to approved", w["trialRun.status"] === "approved");
  is("the Issuer's signature is stamped", w["trialRun.issuerApproval"].uid === "u-iss");
  is("AUTHORISING DOES NOT ENERGISE: no equipment or certificate status written",
    w.status === undefined && wrote(tx, "equipment", "EQ1") === null);

  await check("an Admin may authorise as superuser",
    run("txTrialApprove", store(trial("requested", all)), { actor: ADMIN }), "ok");
  await check("a requester may not authorise",
    run("txTrialApprove", store(trial("requested", all)), { actor: REQ_A }), "gate");
  await check("an Isolator may not authorise",
    run("txTrialApprove", store(trial("requested", all)), { actor: ISOLATOR }), "gate");
  await check("a crew still to answer blocks authorisation",
    run("txTrialApprove", store(trial("requested", [says("B", "consent")])), { actor: ISSUER }), "gate");
  await check("a refusal blocks authorisation",
    run("txTrialApprove", store(trial("requested", [says("B", "consent"), says("C", "refuse")])), { actor: ISSUER }), "gate");
  await check("authorising twice refuses",
    run("txTrialApprove", store(trial("approved", all)), { actor: ISSUER }), "gate");
}

/* ===================== 4. Cancel ===================== */
console.log("\nCalled off before the locks came out:");
{
  const tx = await check("the crew that asked may cancel",
    run("txTrialCancel", store(trial("requested")), { actor: REQ_A, reason: "not needed" }), "ok");
  const w = wrote(tx, "isolations", "C1");
  is("the request is cleared", w.trialRun === null);
  is("it is kept in the log as cancelled", unioned(w.trialRunLog).outcome === "cancelled");

  await check("an Issuer may cancel an authorised request",
    run("txTrialCancel", store(trial("approved")), { actor: ISSUER }), "ok");
  await check("an unrelated crew may not cancel",
    run("txTrialCancel", store(trial("requested")), { actor: REQ_B }), "gate");
  // The important one: once the equipment is live, "cancel" is not a way out.
  await check("an ENERGISED trial cannot be cancelled — only re-isolated",
    run("txTrialCancel", store(trial("energised")), { actor: ISSUER }), "gate");
}

/* ===================== 5. Energise (Isolator) ===================== */
console.log("\nOnly the Isolator energises, and only against a live re-check:");
{
  const all = [says("B", "consent"), says("C", "consent")];
  const tx = await check("authorised and all clear → locks come out",
    run("txTrialEnergise", store(trial("approved", all)), { actor: ISOLATOR }), "ok");
  const w = wrote(tx, "isolations", "C1"), e = wrote(tx, "equipment", "EQ1");
  is("the certificate goes to trialRun", w.status === "trialRun");
  is("the sub-document goes to energised", w["trialRun.status"] === "energised");
  is("the Isolator who pulled the locks is stamped", w["trialRun.deisolatedBy"].uid === "u-iso");
  is("the equipment is marked energised", e.isolationStatus === "trialRun");

  await check("an Issuer may not pull the locks",
    run("txTrialEnergise", store(trial("approved", all)), { actor: ISSUER }), "gate");
  await check("the requesting crew may not pull the locks",
    run("txTrialEnergise", store(trial("approved", all)), { actor: REQ_A }), "gate");
  await check("an Admin may as superuser",
    run("txTrialEnergise", store(trial("approved", all)), { actor: ADMIN }), "ok");
  await check("an unauthorised request cannot be energised",
    run("txTrialEnergise", store(trial("requested", all)), { actor: ISOLATOR }), "gate");
  await check("energising twice refuses",
    run("txTrialEnergise", store(trial("energised", all)), { actor: ISOLATOR }), "gate");

  const moved = store(trial("approved", all));
  moved.equipment.EQ1.activeIsolationId = "C9";
  await check("equipment now under a different certificate refuses",
    run("txTrialEnergise", moved, { actor: ISOLATOR }), "gate");
}
console.log("\nThe late-attach hole, closed inside the transaction:");
{
  // Consents complete and the Issuer has signed. While the Isolator walks to
  // the panel, another Issuer approves a fourth permit onto the same lockout.
  // That crew never cleared — the transaction must see them and stop.
  const all = [says("B", "consent"), says("C", "consent")];
  const late = store(trial("approved", all));
  late.permits.D = permit("D");
  late.isolations.C1.attachedPermitIds = ["A", "B", "C", "D"];
  await check("a crew attached after the consents STOPS the energisation",
    run("txTrialEnergise", late, { actor: ISOLATOR }), "gate");

  // The same crew, invisible in attachedPermitIds (rejecting the last permit
  // on a lockout empties that list while permits still point at it) — the
  // caller's page list is unioned in, so they are still seen.
  const hidden = store(trial("approved", all));
  hidden.permits.D = permit("D");
  hidden.isolations.C1.attachedPermitIds = [];
  await check("...even when the certificate's own list has been emptied",
    run("txTrialEnergise", hidden, { actor: ISOLATOR, knownIds: ["A", "B", "C", "D"] }), "gate");
}

/* ===================== 6. Re-isolate ===================== */
console.log("\nLocks back on, work resumes:");
{
  const all = [says("B", "consent"), says("C", "consent")];
  const s = store(trial("energised", all), { status: "trialRun" });
  s.equipment.EQ1.isolationStatus = "trialRun";
  const tx = await check("the Isolator re-isolates", run("txTrialReIsolate", s, { actor: ISOLATOR }), "ok");
  const w = wrote(tx, "isolations", "C1"), e = wrote(tx, "equipment", "EQ1");
  is("the certificate returns to active", w.status === "active");
  is("the sub-document is cleared", w.trialRun === null);
  is("the completed trial is kept in the log", unioned(w.trialRunLog).outcome === "completed");
  is("the log records who put the locks back", unioned(w.trialRunLog).reIsolatedBy.uid === "u-iso");
  is("the equipment is isolated again", e.isolationStatus === "isolated");

  await check("an Issuer may not re-apply the locks",
    run("txTrialReIsolate", store(trial("energised", all), { status: "trialRun" }), { actor: ISSUER }), "gate");
  await check("nothing to re-isolate on a quiet certificate",
    run("txTrialReIsolate", store(), { actor: ISOLATOR }), "gate");
  await check("nothing to re-isolate on a merely authorised one",
    run("txTrialReIsolate", store(trial("approved", all)), { actor: ISOLATOR }), "gate");
}
console.log("\nA trial left running by the FIRST version is still recoverable:");
{
  // What the old flow wrote: certificate status trialRun, no sub-document, and
  // an open entry stranded on the one permit that started it. The shared-lockout
  // bug was that re-isolating from a sibling permit left that entry open.
  const s = store(null, { status: "trialRun" });
  s.equipment.EQ1.isolationStatus = "trialRun";
  s.permits.A.trialRuns = [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: null, status: "open" }];
  const tx = await check("a legacy energised certificate can be re-isolated",
    run("txTrialReIsolate", s, { actor: ISOLATOR }), "ok");
  const w = wrote(tx, "isolations", "C1"), pa = wrote(tx, "permits", "A");
  is("the certificate returns to active", w.status === "active");
  is("the legacy trial is recorded in the log", unioned(w.trialRunLog).legacy === true);
  is("the stranded permit entry is closed, not left claiming ENERGISED",
    pa.trialRuns[0].status === "closed" && pa.trialRuns[0].reIsolatedAt === NOW);
  is("permits with no stranded entry are left alone", wrote(tx, "permits", "B") === null);
}

/* ===================== crew reading ===================== */
console.log("\nThe crew list is read from both sources and re-checked:");
{
  const s = store(trial("requested"));
  s.permits.X = permit("X", { isolationRef: "C2" });     // points elsewhere
  s.isolations.C1.attachedPermitIds = ["A", "B", "C", "X", "gone"];
  const tx = mkTx(s);
  const crew = await mod.txReadCrew(tx, "C1", s.isolations.C1, ["A", "D"]);
  is("permits listed but pointing at another certificate are dropped", !crew.some((p) => p.id === "X"));
  is("permits listed but deleted are dropped", !crew.some((p) => p.id === "gone"));
  is("permits named only by the caller are still read", crew.length === 3);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
