/* Auto-rejection — the rule that ends a permit nobody ever decided on.

   Five properties matter here, and none of them is visible from reading the UI:

     - an approved permit that no Isolator ever confirmed holds a certificate, and
       that certificate holds equipment.activeIsolationId — which the approval
       transaction requires to be empty before ANY other permit on that tag can be
       approved. Releasing that is what auto-rejection is actually for. Section 4
       pins the part of it that is pure logic: such a permit leaves the live set,
       so it stops contributing blocks and stops being listed as concurrent work.
       (The pointer itself is cleared by stampAutoReject, which is a transaction
       and so is out of reach of these tests — the emulator suite is where a claim
       about a write belongs.)

     - the permit's OWN planned end is the primary rule. The fixed timeout exists
       only for open-ended permits, and when both apply the earlier one wins —
       otherwise a permit could be approved days after the window it asked for.

     - a permit holding a LOCKOUT is never auto-rejected. Rejecting an
       awaitingIsolation permit by hand decides whether physical locks stay on;
       automation may only ever take the branch where the certificate is still
       `assigned` (so the locks were demonstrably never applied) and no other
       crew shares it. Section 3 pins every way that guard can be reached,
       because getting it wrong means telling somebody to remove locks that a
       crew is standing behind — or freeing equipment that is still isolated.

     - the deadline is announced before it lands (the `warn` phase). A deadline
       a person can only discover by losing to it would make the feature a
       hazard of its own: permits would lapse unseen and be re-raised in a hurry.

     - the clock does not restart on an edit. A permit kept alive by touching it
       is the exact thing the deadline exists to prevent.

   Runs the shipped helpers lifted out of app.js.
   Run: node tests/auto-reject.mjs                                            */
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
// One-liners, where grab() would stop at the first closing brace of the body.
function grabLine(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("not found in app.js: " + sig);
  return src.slice(i, src.indexOf("\n", i));
}

const M = new Function(`
  ${grabLine("const AUTO_REJECT_DEFAULT =")}
  ${grab("function isoIndex(isolations)")}
  ${grab("function permitEnd(p)")}
  ${grab("function permitStage(p, isolations)")}
  ${grab("function permitsByIso(permits)")}
  ${grab("function isoReadyForDeiso(iso, permits, byIso)")}
  ${grab("function autoRejectFrom(p)")}
  ${grab("function autoRejectDue(p, pol)")}
  ${grab("function autoRejectSafe(p, isolations)")}
  ${grab("function autoRejectState(p, isolations, pol, now = Date.now())")}
  ${grabLine("function isAutoRejected(p, isolations, pol)")}
  ${grab("function permitDead(p, isolations, pol)")}
  ${grab("function equipmentBlock(eqId, permits, isolations, excludeId, pol = null)")}
  return { AUTO_REJECT_DEFAULT, autoRejectFrom, autoRejectDue, autoRejectSafe,
           autoRejectState, isAutoRejected, permitDead, equipmentBlock };
`)();

const { AUTO_REJECT_DEFAULT, autoRejectFrom, autoRejectDue, autoRejectSafe,
        autoRejectState, isAutoRejected, permitDead, equipmentBlock } = M;

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

const POL = { ...AUTO_REJECT_DEFAULT };
const HOUR = 3600000;
// The real clock, not a fixed date: isAutoRejected / permitDead / equipmentBlock
// deliberately take no `now` (they are called from renders), so every fixture has
// to be built relative to the same clock they read or the two drift apart.
const NOW = Date.now();
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

// A permit submitted `hoursAgo` hours ago, open-ended unless given a planned end.
const submitted = (hoursAgo, over = {}) => ({
  id: "P1", permitNo: "PTW-1", status: "submitted", equipmentRef: "EQ1",
  submittedAt: iso(-hoursAgo * HOUR), createdAt: iso(-hoursAgo * HOUR),
  validity: { start: iso(-hoursAgo * HOUR), openEnded: true, plannedEnd: null },
  ...over
});
// An approved permit waiting on an Isolator, attached to certificate C1.
const awaiting = (hoursAgo, over = {}) => ({
  id: "P1", permitNo: "PTW-1", status: "awaitingIsolation", equipmentRef: "EQ1",
  isolationRef: "C1", isoNo: "NRCC-ISO-1",
  approval: { issuerUid: "u9", timestamp: iso(-hoursAgo * HOUR) },
  validity: { start: iso(-hoursAgo * HOUR), openEnded: true, plannedEnd: null },
  ...over
});
const cert = (over = {}) => ({ id: "C1", status: "assigned", attachedPermitIds: ["P1"], ...over });
const phase = (p, isos, now = NOW) => autoRejectState(p, isos, POL, now)?.phase ?? null;

console.log("\nOnly a permit that is waiting on somebody has a deadline:");
{
  for (const st of ["draft", "active", "extended", "closed", "rejected", "expired"])
    check(`${st} → no deadline`, autoRejectDue({ ...submitted(999), status: st }, POL) === null);
  check("submitted → has one", autoRejectDue(submitted(1), POL) !== null);
  check("awaitingIsolation → has one", autoRejectDue(awaiting(1), POL) !== null);
  check("policy disabled → none at all", autoRejectDue(submitted(999), { ...POL, enabled: false }) === null);
  // A permit with no usable date AND no planned end cannot be judged. Guessing
  // would auto-reject records written before submittedAt existed.
  check("undatable and open-ended → never accused",
    autoRejectDue({ status: "submitted", validity: { openEnded: true } }, POL) === null);
}

console.log("\nThe fixed timeout, for the open-ended permits the planned end cannot reach:");
{
  check("well inside the window → pending", phase(submitted(1), []) === "pending");
  check("one hour short of the deadline → warned, not lapsed", phase(submitted(POL.submittedHours - 1), []) === "warn");
  check("exactly on the deadline → lapsed", phase(submitted(POL.submittedHours), []) === "lapsed");
  check("past it → lapsed", phase(submitted(POL.submittedHours + 50), []) === "lapsed");
  // The approved permit is already holding a certificate, so it gets less rope.
  check("awaiting isolation uses its own, shorter clock",
    POL.awaitingIsolationHours < POL.submittedHours &&
    phase(awaiting(POL.awaitingIsolationHours + 1), [cert()]) === "lapsed");
  check("…and that clock is genuinely shorter — at the same age a submitted permit lives on",
    phase(awaiting(POL.awaitingIsolationHours + 1), [cert()]) === "lapsed" &&
    phase(submitted(POL.awaitingIsolationHours + 1), []) !== "lapsed");
  check("an approved permit's clock runs from APPROVAL, not creation",
    autoRejectFrom(awaiting(2, { createdAt: iso(-900 * HOUR) })) === iso(-2 * HOUR));
}

console.log("\nThe permit's own planned end is the primary rule:");
{
  const p = submitted(1, { validity: { openEnded: false, plannedEnd: iso(-1 * HOUR) } });
  check("planned end already passed → lapsed, however new the permit is", phase(p, []) === "lapsed");
  check("…and the reason recorded is the planned end, not the timeout",
    autoRejectState(p, [], POL, NOW).rule === "plannedEnd");
  // Both rules apply at once: whichever falls first wins, in both directions.
  const soon = submitted(1, { validity: { openEnded: false, plannedEnd: iso(2 * HOUR) } });
  check("planned end sooner than the timeout → planned end wins",
    autoRejectState(soon, [], POL, NOW).rule === "plannedEnd");
  const late = submitted(1, { validity: { openEnded: false, plannedEnd: iso(500 * HOUR) } });
  check("timeout sooner than the planned end → timeout wins",
    autoRejectState(late, [], POL, NOW).rule === "idle");
  check("a distant planned end does not rescue an idle permit",
    phase(submitted(POL.submittedHours + 1, { validity: { openEnded: false, plannedEnd: iso(500 * HOUR) } }), []) === "lapsed");
  // An extension is the Issuer's explicit new end date, so permitEnd prefers it.
  check("an extension moves the planned-end rule with it",
    autoRejectState(submitted(1, { validity: { openEnded: false, plannedEnd: iso(-1 * HOUR), extendedTo: iso(2 * HOUR) } }), [], POL, NOW).rule === "plannedEnd" &&
    phase(submitted(1, { validity: { openEnded: false, plannedEnd: iso(-1 * HOUR), extendedTo: iso(2 * HOUR) } }), []) !== "lapsed");
}

console.log("\nThe deadline is announced before it lands:");
{
  check("first half of the wait → quiet", phase(submitted(POL.submittedHours * 0.4), []) === "pending");
  check("past halfway → warned", phase(submitted(POL.submittedHours * 0.6), []) === "warn");
  check("a warn is not a lapse", !isAutoRejected(submitted(POL.submittedHours * 0.9), [], POL));
  const st = autoRejectState(submitted(POL.submittedHours * 0.6), [], POL, NOW);
  check("the warning carries the actual deadline, not a guess",
    st.at === NOW + POL.submittedHours * 0.4 * HOUR);
}

console.log("\nA permit holding a lockout is NEVER auto-rejected:");
{
  const old = (over) => awaiting(POL.awaitingIsolationHours + 10, over);
  // The one safe case: locks demonstrably never applied, nobody else on the cert.
  check("assigned certificate, this permit alone → lapsed",
    phase(old(), [cert()]) === "lapsed");
  // Every other certificate state means an Isolator has signed that locks are ON.
  for (const status of ["active", "trialRun", "removalPending"])
    check(`certificate ${status} → held, never lapsed`, phase(old(), [cert({ status })]) === "held");
  check("assigned but SHARED with another crew → held",
    phase(old(), [cert({ attachedPermitIds: ["P1", "P2"] })]) === "held");
  check("a dangling certificate reference → held (lock state unknown, never guess)",
    phase(old(), []) === "held");
  check("a certificate already removed → lapsed (nothing left to disturb)",
    phase(old(), [cert({ status: "removed" })]) === "lapsed");
  check("held is past the deadline but is NOT an auto-rejection",
    !isAutoRejected(old(), [cert({ status: "active" })], POL));
  // A submitted permit has no certificate yet — one is minted at approval — so
  // the guard must resolve without any certificate list at all. The nav badge
  // depends on this: it counts pending permits without fetching certificates.
  check("a submitted permit needs no certificate list to be judged",
    autoRejectSafe(submitted(1), []) === true &&
    phase(submitted(POL.submittedHours + 1), []) === "lapsed");
}

console.log("\nAn auto-rejected permit leaves the live set that guards the equipment:");
{
  const eqOf = (ps, isos, pol) => equipmentBlock("EQ1", ps, isos, null, pol);
  // The certificate is what actually blocks: a stale lockout in hand-back holds
  // the tag. Note the shape of these checks — WITHOUT a policy the block persists,
  // which is both the old behaviour and the proof that any release comes from
  // auto-rejection and not from some unrelated change to the availability rule.
  const stale = (over) => [awaiting(POL.awaitingIsolationHours + 100, { id: "OLD", ...over })];
  const handback = [{ id: "C1", status: "removalPending", attachedPermitIds: ["OLD"] }];
  check("a stale permit on a lockout in hand-back blocks when auto-rejection is off",
    eqOf(stale(), handback, null)?.kind === "awaitingDeisolation");
  check("…and still blocks WITH it, because a lockout in hand-back is never auto-rejected",
    eqOf(stale(), handback, POL)?.kind === "awaitingDeisolation");
  // The one case automation may release: locks never applied, no other crew.
  const neverApplied = [cert({ id: "C1", attachedPermitIds: ["OLD"], status: "assigned" })];
  check("an auto-rejected permit whose locks were never applied stops holding the tag",
    eqOf(stale(), neverApplied, POL) === null);
  // Awaiting closure is a different rule entirely and must be untouched by any
  // of this — auto-rejection only ever speaks for permits awaiting a decision.
  const closing = [{ ...submitted(1, { id: "DONE" }), status: "active", workCompletion: { timestamp: iso(-HOUR) }, isolationRef: null }];
  check("a permit awaiting closure blocks, policy or not",
    eqOf(closing, [], null)?.kind === "awaitingClosure" && eqOf(closing, [], POL)?.kind === "awaitingClosure");
  check("a fresh submitted permit is untouched by any of this",
    eqOf([submitted(1)], [], POL) === null);
}

console.log("\nAn auto-rejected permit counts as finished wherever the app asks:");
{
  check("stored expired → dead", permitDead({ status: "expired" }, [], POL));
  check("derived lapse → dead before anything is written",
    permitDead(submitted(POL.submittedHours + 1), [], POL));
  check("held → NOT dead, it is still the Issuer's to decide",
    !permitDead(awaiting(POL.awaitingIsolationHours + 10), [cert({ status: "active" })], POL));
  check("closed and rejected are unaffected",
    permitDead({ status: "closed" }, [], POL) && permitDead({ status: "rejected" }, [], POL));
  check("an active permit is not dead", !permitDead(submitted(1, { status: "active" }), [], POL));
}

console.log("\nThe clock cannot be restarted by touching the permit:");
{
  // submittedAt is stamped once and preferred over updatedAt, so editing a
  // submitted permit (which rewrites updatedAt) does not buy it another 72 hours.
  const edited = submitted(POL.submittedHours + 1, { updatedAt: iso(-HOUR) });
  check("an edit does not extend the wait", phase(edited, []) === "lapsed");
  check("submittedAt is what is read", autoRejectFrom(edited) === edited.submittedAt);
  // Records written before submittedAt existed still have to be judged somehow.
  const legacy = { status: "submitted", updatedAt: iso(-(POL.submittedHours + 1) * HOUR), createdAt: iso(-900 * HOUR), validity: { openEnded: true } };
  check("older records fall back to updatedAt", autoRejectFrom(legacy) === legacy.updatedAt);
  check("…and are judged on it", phase(legacy, []) === "lapsed");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
