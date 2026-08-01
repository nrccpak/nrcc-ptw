/* What a trial run LOOKS like on a permit, for every crew sharing the lockout.

   The state moved to the certificate so that all crews see it, which makes the
   rendering safety-relevant rather than cosmetic:

     - a crew that did not ask for the trial must still see ENERGISED on their
       own permit, including for a certificate energised by the first version
       of this feature, which wrote no sub-document
     - "authorised" must never be drawn the same as "energised": the Issuer's
       signature is permission, the locks are still on
     - the trial run is a CHIP beside the permit's status, never a status —
       a permit in a trial run is still an active permit, and permitStage()'s
       three values are load-bearing elsewhere
     - trials recorded by the earlier flow must not vanish from the log just
       because the record moved to the certificate
     - reasons and remarks are free text typed by users and go into innerHTML

   Run: node tests/trial-run-view.mjs                                        */
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
const STATUS_LABEL_SRC = src.slice(src.indexOf("const STATUS_LABEL ="),
  src.indexOf(";", src.indexOf('removed: "Removed"')) + 1);

const M = new Function(`
  ${grabLine("const esc = (s) =>")}
  ${grab("function fmt(iso)")}
  ${STATUS_LABEL_SRC}
  ${grab("function personText(name, meta)")}
  ${grabLine("function personHTML(name, meta)")}
  ${grab("function trialStage(iso)")}
  ${grab("function isTrialEnergised(iso)")}
  ${grab("function trialConsentTargets(iso, permits, requestingPermitId)")}
  ${grab("function trialConsentState(iso, permits)")}
  ${grab("function trialChip(iso)")}
  ${grab("function trialLiveHTML(iso, permits)")}
  ${grab("function trialHistoryHTML(iso, permit)")}
  return { trialChip, trialLiveHTML, trialHistoryHTML };
`)();
const { trialChip, trialLiveHTML, trialHistoryHTML } = M;

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

const AT = "2026-08-01T09:00:00.000Z";
const person = (n) => ({ uid: "u-" + n, name: n, jobTitle: "", department: "", employeeNumber: "" });
const cert = (trialRun, over = {}) => ({ id: "C1", status: "active", trialRun, ...over });
const trial = (status, over = {}) => ({
  status, permitId: "A", permitNo: "PTW-A", reason: "prove the seal",
  requestedBy: person("Amir"), requestedAt: AT, consents: [], issuerApproval: null, ...over
});

console.log("\nThe chip says exactly which of the three states the lockout is in:");
{
  check("no certificate → no chip", trialChip(null) === "");
  check("no trial → no chip", trialChip(cert(null)) === "");
  check("requested → amber pending chip",
    trialChip(cert(trial("requested"))).includes("stage-trialPending") &&
    trialChip(cert(trial("requested"))).includes("requested"));
  // The distinction that matters most: authorised is not live.
  check("authorised → pending, NOT energised",
    trialChip(cert(trial("approved"))).includes("stage-trialPending") &&
    !trialChip(cert(trial("approved"))).includes("ENERGISED"));
  check("energised → the loud red chip",
    trialChip(cert(trial("energised"))).includes("stage-trialRun") &&
    trialChip(cert(trial("energised"))).includes("ENERGISED"));
  // A crew on the lockout that never asked still has to see this.
  check("a certificate energised by the earlier flow still shows ENERGISED",
    trialChip({ id: "C1", status: "trialRun" }).includes("ENERGISED"));
  check("the chip is never a permit status",
    !trialChip(cert(trial("energised"))).includes("badge-st st-"));
}

console.log("\nOn the certificate, the Isolator is told the state of the LOCKS:");
{
  const crew = [
    { id: "pA", permitNo: "PTW-A", status: "active", isolationRef: "C1", requester: { uid: "u-A" } },
    { id: "pB", permitNo: "PTW-B", status: "active", isolationRef: "C1", requester: { uid: "u-B" } },
    { id: "pC", permitNo: "PTW-C", status: "active", isolationRef: "C1", requester: { uid: "u-C" } }
  ];
  const answered = [{ permitId: "pA", decision: "requested" }, { permitId: "pB", permitNo: "PTW-B", decision: "consent" }];

  check("no trial → no card", trialLiveHTML(cert(null), crew) === "");

  const waiting = trialLiveHTML(cert(trial("requested", { permitId: "pA", consents: answered })), crew);
  // The decision an Isolator is about to make rests on this list, so it says
  // both halves — who has cleared and who has not — rather than a count.
  check("the crews that cleared are named", waiting.includes("PTW-B"));
  check("the crews still to clear are named", waiting.includes("PTW-C"));
  check("a pending trial says the locks are still ON", waiting.includes("ON — equipment still isolated"));
  check("and that it is not authorised yet", waiting.includes("Not yet authorised"));

  const ready = trialLiveHTML(cert(trial("approved", {
    permitId: "pA", consents: [...answered, { permitId: "pC", permitNo: "PTW-C", decision: "consent" }],
    issuerApproval: { ...person("Sara"), at: AT } })), crew);
  check("every crew cleared is stated plainly", ready.includes("None — every crew has cleared"));
  check("the authorising Issuer is named", ready.includes("Sara"));
  // The distinction the Isolator must not misread: authorised is not live.
  check("an AUTHORISED trial still says the locks are ON", ready.includes("ON — equipment still isolated"));
  check("and never says energised", !ready.includes("ENERGISED"));

  const live = trialLiveHTML(cert(trial("energised", {
    permitId: "pA", consents: answered, issuerApproval: { ...person("Sara"), at: AT },
    deisolatedBy: person("Imran"), deisolatedAt: AT }), { status: "trialRun" }), crew);
  check("an energised trial says the locks are OUT", live.includes("OUT — equipment ENERGISED"));
  check("and names who took them out", live.includes("Imran"));

  // A certificate energised by the earlier flow has no sub-document, so there
  // is no live card to draw — the banner and chip carry that state instead.
  check("a legacy energised certificate draws no card",
    trialLiveHTML({ id: "C1", status: "trialRun", trialRun: null }, crew) === "");
}

console.log("\nThe log shows every trial this lockout has seen:");
{
  check("nothing to show → no card at all", trialHistoryHTML(cert(null), { trialRuns: [] }) === "");
  check("no certificate and no legacy entries → no card", trialHistoryHTML(null, {}) === "");
}
{
  const live = trialHistoryHTML(cert(trial("energised", { deisolatedBy: person("Imran"), deisolatedAt: AT })), {});
  check("a trial in flight is listed", live.includes("Trial run log") && live.includes("Amir"));
  check("an unfinished trial is called out as open", live.includes("OPEN — equipment energised"));
  check("the Isolator who took the locks out is named", live.includes("Imran"));
}
{
  const done = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed", {
    outcome: "completed", issuerApproval: { ...person("Sara"), at: AT },
    deisolatedBy: person("Imran"), deisolatedAt: AT,
    reIsolatedBy: person("Imran"), reIsolatedAt: AT,
    consents: [{ permitId: "A", decision: "requested" }, { permitId: "B", permitNo: "PTW-B", decision: "consent" }]
  })] }), {});
  check("a completed trial is marked completed", done.includes("✔ Completed"));
  check("it is not also reported as open", !done.includes("OPEN — equipment energised"));
  check("the authorising Issuer is named", done.includes("Sara"));
  check("the crews that cleared are listed", done.includes("PTW-B") && done.includes("cleared"));
  check("the requester's own entry is not listed as a crew answer",
    (done.match(/cleared/g) || []).length === 1);
}
{
  const refused = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed", {
    outcome: "refused", consents: [{ permitId: "B", permitNo: "PTW-B", decision: "refuse" }],
    closedBy: person("Bilal"), closedAt: AT })] }), {});
  check("a refused trial says so", refused.includes("Refused by a crew"));
  check("and names who refused", refused.includes("PTW-B") && refused.includes("refused"));
  const cancelled = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed",
    { outcome: "cancelled", closedBy: person("Amir"), closedAt: AT, closeReason: "not needed" })] }), {});
  check("a cancelled trial says so", cancelled.includes("Cancelled") && cancelled.includes("not needed"));
  const abandoned = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed", { outcome: "abandoned" })] }), {});
  check("an abandoned trial is not dressed up as completed",
    abandoned.includes("Abandoned") && !abandoned.includes("✔ Completed"));
}

console.log("\nThe log says whether the crew got to finish the trial:");
{
  const signedOff = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed", {
    outcome: "completed", deisolatedBy: person("Imran"), deisolatedAt: AT,
    completedBy: person("Amir"), completedAt: AT, completionRemarks: "seal holding",
    reIsolatedBy: person("Imran"), reIsolatedAt: AT })] }), {});
  check("a trial the crew signed off names who signed it", signedOff.includes("Crew confirmed finished by"));
  check("and keeps their result", signedOff.includes("seal holding"));
  check("it is not flagged as cut short", !signedOff.includes("before the crew confirmed"));

  // Re-isolating early is allowed — an Isolator must always be able to make
  // equipment safe — but the record has to show the trial was cut short, or a
  // crew asking why their test stopped has nothing to point at.
  const cutShort = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed", {
    outcome: "completed", deisolatedBy: person("Imran"), deisolatedAt: AT,
    reIsolatedBy: person("Imran"), reIsolatedAt: AT })] }), {});
  check("a trial cut short says so", cutShort.includes("Re-isolated before the crew confirmed"));
  check("it is still recorded as completed", cutShort.includes("✔ Completed"));

  // Legacy records had no sign-off step at all, so the flag would be a lie.
  const legacy = trialHistoryHTML(cert(null), { permitNo: "PTW-A",
    trialRuns: [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: AT, status: "closed" }] });
  check("an old record is never flagged as cut short", !legacy.includes("before the crew confirmed"));
}

console.log("\nTrials recorded by the earlier flow are still in the audit trail:");
{
  const legacyDone = trialHistoryHTML(cert(null), { permitNo: "PTW-A",
    trialRuns: [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: AT, status: "closed" }] });
  check("an old completed trial is still listed", legacyDone.includes("Admin"));
  check("it is marked as coming from the earlier flow", legacyDone.includes("earlier trial-run flow"));
  check("it reads as completed", legacyDone.includes("✔ Completed"));

  const legacyOpen = trialHistoryHTML(cert(null), { permitNo: "PTW-A",
    trialRuns: [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: null, status: "open" }] });
  check("an old trial never closed out still shows as open",
    legacyOpen.includes("OPEN — equipment energised"));

  // Both sources at once: the old record must not be dropped when the
  // certificate has taken over.
  const both = trialHistoryHTML(cert(trial("requested")), { permitNo: "PTW-A",
    trialRuns: [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: AT, status: "closed" }] });
  check("old and new records are shown together",
    both.includes("Admin") && both.includes("Amir"));
  check("the older record is listed first", both.indexOf("Admin") < both.indexOf("Amir"));
}

console.log("\nFree text typed by users is escaped, not executed:");
{
  const nasty = `<img src=x onerror="alert(1)">`;
  const out = trialHistoryHTML(cert(trial("requested", { reason: nasty, permitNo: nasty,
    requestedBy: { name: nasty }, consents: [{ permitId: "B", permitNo: nasty, decision: "consent" }] })), {});
  check("no raw markup survives anywhere in the card", !out.includes("<img"));
  // Four injection points in one render: reason, permit number, requester name
  // and the consent list. esc() leaves the literal text `onerror=` alone — what
  // must not survive is the angle bracket and the attribute quote.
  check("every one of the four fields is escaped", out.split("&lt;img").length - 1 === 4);
  check("attribute quotes are escaped too", !/onerror="/.test(out));
  const nastyClose = trialHistoryHTML(cert(null, { trialRunLog: [trial("closed",
    { outcome: "cancelled", closedBy: { name: "x" }, closeReason: nasty })] }), {});
  check("a cancellation reason cannot inject markup", !nastyClose.includes("<img"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
