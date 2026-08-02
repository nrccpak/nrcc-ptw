/* The trial-run consent engine — the rules that decide whether isolated
   equipment may be energised while crews are still holding permits on it.

   Four properties matter here and none of them is visible from reading the UI:

     - the trial-run record lives on the CERTIFICATE, so every crew under one
       lockout is judged against the same record (the first version kept it on
       one permit, which let a shared lockout be re-isolated from a sibling
       permit while the original permit's log still said ENERGISED)
     - "approved" does not mean energised; only the Isolator pulling the locks
       does, and the two must never be confused by a caller
     - consent is required from every crew still ON THE TOOLS under the
       certificate, and only those: a crew that has confirmed work complete has
       already declared the equipment safe to return to service, so asking them
       again only delays the trial
     - readiness is recomputed from the live permit list, so a permit approved
       onto the certificate AFTER the consents were gathered puts the trial
       back to not-ready rather than slipping through

   Section 2 is a non-regression check: the trial-run sub-document must be
   invisible to the existing cycle/hand-back logic. If adding it changes any
   answer those functions give, the feature has damaged the system it sits in.

   Runs the shipped helpers lifted out of app.js.
   Run: node tests/trial-run.mjs                                             */
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

function grabLine(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("not found in app.js: " + sig);
  return src.slice(i, src.indexOf("\n", i));
}

const M = new Function(`
  const nowISO = () => new Date().toISOString();
  ${grab("function trialStage(iso)")}
  ${grab("function isTrialEnergised(iso)")}
  ${grab("function trialConsentTargets(iso, permits, requestingPermitId)")}
  ${grab("function trialConsentState(iso, permits)")}
  ${grab("function trialReadyToEnergise(iso, permits)")}
  ${grab("function handbackHold(iso, verb)")}
  ${grabLine("const TRIAL_LIVE_ALERT_HRS =")}
  ${grabLine("const TRIAL_MAX_MINUTES =")}
  ${grab("function trialOverrun(iso, now)")}
  ${grab("function trialTasks(isolations, permits)")}
  ${grab("function trialTasksFor(tasks, role)")}
  ${grab("function isoIndex(isolations)")}
  ${grab("function permitStage(p, isolations)")}
  ${grab("function permitsByIso(permits)")}
  ${grab("function isoReadyForDeiso(iso, permits, byIso)")}
  // equipmentBlock now consults the auto-rejection derivation, so its whole
  // dependency chain comes along. Passing no policy (the default) leaves it off,
  // which is what pins the pre-existing behaviour these cases describe.
  ${grab("function permitEnd(p)")}
  ${grab("function autoRejectFrom(p)")}
  ${grab("function autoRejectDue(p, pol)")}
  ${grab("function autoRejectSafe(p, isolations)")}
  ${grab("function autoRejectState(p, isolations, pol, now = Date.now())")}
  ${grabLine("function isAutoRejected(p, isolations, pol)")}
  ${grab("function equipmentBlock(eqId, permits, isolations, excludeId, pol = null)")}
  return { trialStage, isTrialEnergised, trialConsentTargets, trialConsentState,
           trialReadyToEnergise, handbackHold, trialOverrun, trialTasks, trialTasksFor,
           permitStage, isoReadyForDeiso, equipmentBlock };
`)();

const { trialStage, isTrialEnergised, trialConsentTargets, trialConsentState,
        trialReadyToEnergise, handbackHold, trialOverrun, trialTasks, trialTasksFor,
        permitStage, isoReadyForDeiso, equipmentBlock } = M;

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

const AT = "2026-08-01T09:00:00.000Z";
// A live permit on certificate C1 unless told otherwise.
const permit = (id, over = {}) => ({
  id, permitNo: "PTW-" + id, status: "active", equipmentRef: "EQ1",
  isolationRef: "C1", requester: { uid: "u-" + id, name: id }, ...over
});
// A confirmed certificate carrying a trial-run sub-document.
const cert = (trialRun = null, over = {}) => ({
  id: "C1", status: "active", equipmentTag: "P-101A", activeIsolationId: "C1",
  attachedPermitIds: ["A", "B", "C"], trialRun, ...over
});
// A trial raised by permit A, with whatever answers have come back so far.
const trial = (status, consents = [], over = {}) => ({
  status, permitId: "A", permitNo: "PTW-A", reason: "prove the seal",
  requestedBy: { uid: "u-A", name: "A" }, requestedAt: AT,
  consents: [{ permitId: "A", uid: "u-A", decision: "requested", at: AT }, ...consents],
  issuerApproval: status === "approved" || status === "energised"
    ? { uid: "u-iss", name: "Issuer", at: AT } : null,
  ...over
});
const says = (permitId, decision) => ({ permitId, uid: "u-" + permitId, decision, at: AT });
const ids = (arr) => arr.map((p) => p.id).sort().join(",");

/* ===================== 1. The consent engine ===================== */

console.log("\nA stage is only a stage if the app wrote it:");
{
  check("no certificate → no trial", trialStage(null) === null);
  check("no sub-document → no trial", trialStage(cert()) === null);
  check("requested", trialStage(cert(trial("requested"))) === "requested");
  check("approved", trialStage(cert(trial("approved"))) === "approved");
  check("energised", trialStage(cert(trial("energised"))) === "energised");
  // A value nobody recognises must not read as authority to do anything.
  check("junk status → no trial", trialStage(cert(trial("whatever"))) === null);
  check("missing status → no trial", trialStage(cert({ permitId: "A" })) === null);
}

console.log("\nENERGISED means the locks are off — approval alone never does:");
{
  check("no trial → not energised", isTrialEnergised(cert()) === false);
  check("requested → not energised", isTrialEnergised(cert(trial("requested"))) === false);
  // The distinction the whole feature rests on: the Issuer authorises, the
  // Isolator energises. Reading approval as live would hide a real hazard.
  check("approved → NOT energised", isTrialEnergised(cert(trial("approved"))) === false);
  check("energised → energised", isTrialEnergised(cert(trial("energised"))) === true);
  // Written by the first version of this feature, which had no sub-document.
  check("legacy certificate status alone → energised",
    isTrialEnergised(cert(null, { status: "trialRun" })) === true);
  // A stale or cleared record must never make live equipment look isolated.
  check("certificate says trialRun, sub-document says requested → energised",
    isTrialEnergised(cert(trial("requested"), { status: "trialRun" })) === true);
  check("no certificate → not energised", isTrialEnergised(null) === false);
}

console.log("\nEvery crew still live on the lockout must clear — and only those:");
{
  const permits = [permit("A"), permit("B"), permit("C")];
  check("the crew that asked does not consent to itself",
    ids(trialConsentTargets(cert(), permits, "A")) === "B,C");
  check("extended counts exactly like active",
    ids(trialConsentTargets(cert(), [permit("A"), permit("B", { status: "extended" })], "A")) === "B");
}
{
  // Confirming work complete is the requester's own declaration that the job
  // is finished and the equipment is safe to return to service. Asking that
  // crew to clear again delays the trial without learning anything new — they
  // have already said it. Their locks stay on regardless; the trial does not
  // touch the lockout, only the energisation.
  const permits = [permit("A"), permit("B", { workCompletion: { timestamp: AT } }), permit("C")];
  check("a work-complete crew is not asked again",
    ids(trialConsentTargets(cert(), permits, "A")) === "C");
  check("a work-complete crew never blocks readiness",
    trialReadyToEnergise(cert(trial("approved", [says("C", "consent")])), permits) === true);
}
{
  const permits = [
    permit("A"), permit("B", { status: "closed" }), permit("C", { status: "rejected" }),
    permit("D", { status: "expired" }), permit("E", { status: "awaitingIsolation" }),
    permit("F", { status: "draft" }), permit("G", { status: "submitted" })
  ];
  // Nobody on these is on the tools under this lockout right now.
  check("finished and not-yet-started crews are not asked",
    ids(trialConsentTargets(cert(), permits, "A")) === "");
}
{
  const permits = [permit("A"), permit("X", { isolationRef: "C2" }), permit("Y", { isolationRef: null })];
  check("crews on another lockout are not asked",
    ids(trialConsentTargets(cert(), permits, "A")) === "");
}
{
  // A certificate object with no id matches `p.isolationRef === undefined`,
  // which would collect every permit attached to NO certificate and present
  // them as this lockout's crew — and then hold the trial waiting on them.
  const loose = [permit("A"), permit("N1", { isolationRef: undefined }), permit("N2", { isolationRef: null })];
  const noId = { status: "active", trialRun: null };
  check("an id-less certificate has no crew at all",
    ids(trialConsentTargets(noId, loose, "A")) === "");
  check("...and cannot be judged ready to energise",
    trialReadyToEnergise({ ...noId, trialRun: trial("approved") }, loose) === false);
}

console.log("\nOutstanding is derived from the live permits, not the stored list:");
{
  const permits = [permit("A"), permit("B"), permit("C")];
  {
    const s = trialConsentState(cert(trial("requested")), permits);
    check("nobody has answered yet", ids(s.outstanding) === "B,C");
    // The requester's own entry says who asked. It is not an answer, and it
    // must never stand in for another crew's.
    check("the requester's own entry is not a consent", ids(s.given) === "");
  }
  {
    const s = trialConsentState(cert(trial("requested", [says("B", "consent")])), permits);
    check("one in, one to go", ids(s.given) === "B" && ids(s.outstanding) === "C");
  }
  {
    const s = trialConsentState(cert(trial("requested", [says("B", "consent"), says("C", "refuse")])), permits);
    check("a refusal is recorded as a refusal", ids(s.refused) === "C");
    check("a refusal is not left outstanding", ids(s.outstanding) === "");
  }
  {
    // Consent from a crew that has since closed its permit is not a licence to
    // energise on behalf of whoever is on the lockout now.
    const s = trialConsentState(cert(trial("requested", [says("Z", "consent")])), permits);
    check("consent from a permit not on the lockout is ignored", ids(s.outstanding) === "B,C");
  }
  check("no trial → nothing required", trialConsentState(cert(), permits).required.length === 0);
}

console.log("\nEnergising takes approval AND a clear answer from every crew:");
{
  const permits = [permit("A"), permit("B"), permit("C")];
  const all = [says("B", "consent"), says("C", "consent")];
  check("merely requested is never ready",
    trialReadyToEnergise(cert(trial("requested", all)), permits) === false);
  check("approved with a crew still to answer is not ready",
    trialReadyToEnergise(cert(trial("approved", [says("B", "consent")])), permits) === false);
  check("one refusal blocks it even with everyone else clear",
    trialReadyToEnergise(cert(trial("approved", [says("B", "consent"), says("C", "refuse")])), permits) === false);
  check("approved with no Issuer signature is not ready",
    trialReadyToEnergise(cert(trial("approved", all, { issuerApproval: null })), permits) === false);
  check("all clear and signed → ready",
    trialReadyToEnergise(cert(trial("approved", all)), permits) === true);
  // Locks must be on and staying on. Anything else is not a lockout to lift.
  for (const st of ["assigned", "removalPending", "removed", "trialRun"])
    check(`a ${st} certificate is not ready`,
      trialReadyToEnergise(cert(trial("approved", all), { status: st }), permits) === false);
  check("already energised is not ready again",
    trialReadyToEnergise(cert(trial("energised", all)), permits) === false);
  check("no trial → not ready", trialReadyToEnergise(cert(), permits) === false);
  check("no certificate → not ready", trialReadyToEnergise(null, permits) === false);
}

console.log("\nHand-back is held by a trial run at ANY stage, not just an energised one:");
{
  // Hand-back is the point of no return — the locks come off for good. Taking
  // them off while a crew is waiting to energise would leave a live request
  // pointing at a dead certificate, with that crew still reading "authorised".
  check("a quiet certificate is free to hand back", handbackHold(cert(), "de-isolating") === null);
  check("a requested trial holds it", !!handbackHold(cert(trial("requested")), "de-isolating"));
  check("an authorised trial holds it too", !!handbackHold(cert(trial("approved")), "de-isolating"));
  check("an energised one obviously holds it", !!handbackHold(cert(trial("energised")), "de-isolating"));
  // The state the earlier flow leaves behind: status alone, no sub-document.
  check("a legacy energised certificate holds it",
    !!handbackHold({ id: "C1", status: "trialRun" }, "de-isolating"));
  // An energised certificate gets the message that says what to DO about it.
  check("energised says re-isolate first",
    handbackHold(cert(trial("energised")), "de-isolating").includes("re-isolate before de-isolating"));
  check("a pending one says finish or cancel it",
    handbackHold(cert(trial("requested")), "de-isolating").includes("finish or cancel"));
  check("the verb follows the action being blocked",
    handbackHold(cert(trial("requested")), "releasing").includes("before releasing"));
  check("no certificate, nothing to hold", handbackHold(null, "de-isolating") === null);
  // A finished trial must not hold the lockout forever.
  check("history alone does not hold hand-back",
    handbackHold({ id: "C1", status: "active", trialRun: null, trialRunLog: [trial("closed")] }, "de-isolating") === null);
}

console.log("\nThe late-attach hole — a crew approved after the consents were gathered:");
{
  const before = [permit("A"), permit("B"), permit("C")];
  const c = cert(trial("approved", [says("B", "consent"), says("C", "consent")]));
  check("ready with the crews that answered", trialReadyToEnergise(c, before) === true);
  // The Issuer approves a fourth permit onto the same lockout while the trial
  // is waiting for the Isolator. That crew never cleared, so the equipment
  // must not be energised — this is why the Isolator's transaction recomputes
  // readiness from permits it reads itself rather than trusting the page.
  const after = [...before, permit("D")];
  check("a newly attached crew puts it back to NOT ready", trialReadyToEnergise(c, after) === false);
  check("the new crew is named as outstanding", ids(trialConsentState(c, after).outstanding) === "D");
}

console.log("\nA trial run becomes work on somebody's desk, worst first:");
{
  const permits = [permit("A"), permit("B")];
  const at = (h) => new Date(Date.parse(AT) + h * 3600000).toISOString();
  const c = (id, trialRun, over = {}) => ({ ...cert(trialRun, over), id });

  check("a quiet certificate is not work", trialTasks([c("C1", null)], permits).length === 0);
  {
    const t = trialTasks([c("C1", trial("requested"))], permits)[0];
    check("a request with crews still to clear waits on the crews", t.kind === "consent");
    // Two permits on the lockout, but the crew that asked is not asked again.
    check("and says how many are outstanding", t.outstanding === 1);
  }
  {
    const all = trial("requested", [says("B", "consent")]);
    const t = trialTasks([c("C1", all)], [permit("A"), permit("B")])[0];
    check("once every crew has cleared it waits on the Issuer", t.kind === "authorise");
  }
  {
    const t = trialTasks([c("C1", trial("approved"))], permits)[0];
    check("an authorised trial waits on the Isolator", t.kind === "energise");
    check("its clock starts at the authorisation, not the request",
      t.since === trial("approved").issuerApproval.at);
  }
  {
    const t = trialTasks([c("C1", trial("energised", [], { deisolatedAt: at(3) }), { status: "trialRun" })], permits)[0];
    check("an energised trial waits on the Isolator", t.kind === "reIsolate");
    check("its clock starts when the locks came out", t.since === at(3));
    check("the crew has not signed off", t.done === false);
  }
  {
    const t = trialTasks([c("C1", trial("energised", [], { completedBy: { uid: "u-A" } }), { status: "trialRun" })], permits)[0];
    check("a crew sign-off is carried through to the queue", t.done === true);
  }
  // The state the earlier flow leaves: energised with nothing to read a stage
  // from. It must still appear as work, or it is invisible forever.
  {
    const t = trialTasks([{ id: "C1", status: "trialRun", trialRun: null, updatedAt: at(2) }], permits)[0];
    check("a legacy energised certificate is still work", t && t.kind === "reIsolate");
  }
  {
    // Live equipment outranks everything, whatever order the certificates
    // arrive in — the queue is read top-down by someone in a hurry.
    const list = [c("C1", trial("requested")), c("C2", trial("approved")),
                  c("C3", trial("energised"), { status: "trialRun" })];
    const kinds = trialTasks(list, permits).map((t) => t.kind);
    check("energised sorts first", kinds[0] === "reIsolate");
    check("then authorised, then waiting on crews", kinds.join(",") === "reIsolate,energise,consent");
  }
}

console.log("\nEnergised equipment is everybody's business; the rest is role work:");
{
  const permits = [permit("A"), permit("B")];
  const c = (id, trialRun, over = {}) => ({ ...cert(trialRun, over), id });
  const tasks = trialTasks([c("C1", trial("requested")), c("C2", trial("approved")),
                            c("C3", trial("energised"), { status: "trialRun" })], permits);
  for (const role of ["issuer", "admin", "isolator"])
    check(`${role} sees all three`, trialTasksFor(tasks, role).length === 3);
  const asCrew = trialTasksFor(tasks, "requester");
  // A live machine is a hazard whether or not you are the one who acts on it.
  check("a requester still sees the energised one", asCrew.length === 1 && asCrew[0].kind === "reIsolate");
}

console.log("\nA trial is judged against the time the crew asked for:");
{
  const at = (mins) => new Date(Date.parse(AT) + mins * 60000).toISOString();
  const live = (over = {}) => cert(trial("energised", [], { deisolatedAt: AT, ...over }), { status: "trialRun" });

  check("nothing to measure before the locks come out",
    trialOverrun(cert(trial("approved"))) === null);
  check("nor on a quiet certificate", trialOverrun(cert()) === null);
  {
    const o = trialOverrun(live({ expectedMinutes: 10 }), at(4));
    check("inside the estimate is not an overrun", o.over === false);
    check("it reports the minutes actually elapsed", o.elapsed === 4);
    check("and the figure the crew gave", o.expected === 10 && o.stated === true);
  }
  check("past the estimate is an overrun",
    trialOverrun(live({ expectedMinutes: 10 }), at(11)).over === true);
  check("exactly on the estimate is not yet over",
    trialOverrun(live({ expectedMinutes: 10 }), at(10)).over === false);
  {
    // No figure given — fall back to the site default rather than never alarming.
    const o = trialOverrun(live(), at(30));
    check("with no estimate the default stands in", o.expected === 60 && o.stated === false);
    check("and 30 min is inside it", o.over === false);
    check("but 90 min is not", trialOverrun(live(), at(90)).over === true);
  }
  {
    // Junk falls back to the default rather than disabling the alarm.
    for (const bad of [0, -5, "abc", null, undefined])
      check(`an estimate of ${JSON.stringify(bad)} falls back to the default`,
        trialOverrun(live({ expectedMinutes: bad }), at(180)).over === true);
    // And a figure large enough to silence the alarm forever is capped: the
    // estimate is the crew's own, so without a cap they could set it to a year.
    const huge = trialOverrun(live({ expectedMinutes: 99999999 }), at(600));
    check("an absurd estimate is capped at a shift", huge.expected === 480);
    check("so it still alarms once the shift is up", huge.over === true);
  }
  check("an unparseable start time measures nothing",
    trialOverrun(cert(trial("energised", [], { deisolatedAt: "not a date" }), { status: "trialRun" }), AT) === null);
}

/* ============ 2. Non-regression: invisible to the rest of the app ============ */

console.log("\nThe trial-run sub-document changes no existing answer:");
{
  const permits = [permit("A", { workCompletion: { timestamp: AT } }), permit("B")];
  const plain = cert();
  const withTrial = [trial("requested"), trial("approved"), trial("energised")];
  const eq = [{ id: "EQ1", activeIsolationId: "C1" }];

  const basePermitStage = permits.map((p) => permitStage(p, [plain])).join("|");
  const baseReady = isoReadyForDeiso(plain, permits);
  const baseBlock = JSON.stringify(equipmentBlock("EQ1", permits, [plain], null));

  for (const t of withTrial) {
    const c = cert(t);
    check(`permitStage unchanged with a ${t.status} trial`,
      permits.map((p) => permitStage(p, [c])).join("|") === basePermitStage);
    check(`isoReadyForDeiso unchanged with a ${t.status} trial`,
      isoReadyForDeiso(c, permits) === baseReady);
    check(`equipmentBlock unchanged with a ${t.status} trial`,
      JSON.stringify(equipmentBlock("EQ1", permits, [c], null)) === baseBlock);
  }
  check("equipment fixture is the one the block was computed for", eq[0].activeIsolationId === "C1");
}
{
  // Hand-back must still open the moment the last crew signs off, whether or
  // not a trial was requested along the way — the certificate stays "active"
  // through request and approval precisely so this keeps working.
  const done = [permit("A", { workCompletion: { timestamp: AT } }),
                permit("B", { workCompletion: { timestamp: AT } })];
  check("all crews signed off → ready for de-isolation, trial or not",
    isoReadyForDeiso(cert(trial("approved")), done) === true &&
    isoReadyForDeiso(cert(), done) === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
