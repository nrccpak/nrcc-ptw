/* The whole trial run, end to end, with the real rules enforced.

   tests/rules-trial-run.mjs asserts what the rules permit, using writes written
   by hand to look like the app's. tests/trial-run-tx.mjs asserts what the
   transactions do, against a simulated transaction with no rules at all.
   Neither proves the two halves fit: the app could send a shape the rules
   refuse, and every suite would still be green while the feature was dead in
   production.

   This one closes that gap. It lifts the SHIPPED transaction cores out of
   app.js and runs them through real Firestore transactions against the
   emulator, signed in as the real roles, with firestore.rules enforced —
   request, clear, authorise, energise, re-isolate, refuse, cancel.

   It also runs the case that matters most: a TAMPERED client. The transaction
   cores take the signer's role as an argument, so a modified app can simply
   claim to be an Isolator. Those cases sign in as somebody else and lie about
   the role, and the server has to be what stops them.

   Requires the emulator. Run:
     node_modules/.bin/firebase emulators:exec --only firestore \
       --project nrcc-rules-test "node tests/rules-trial-run-flow.mjs"      */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc as sdkDoc, setDoc, getDoc, runTransaction, arrayUnion } from "firebase/firestore";

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

// The lifted cores call doc(db, ...) against the module's own db. Point that at
// whichever signed-in connection is driving the current step.
let DB = null;
const mod = new Function("docFn", "arrayUnionFn", `
  const doc = docFn, db = {}, arrayUnion = arrayUnionFn;
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
  ${grab("async function txTrialComplete(tx, o)")}
  ${grab("async function txTrialReIsolate(tx, o)")}
  return { GateError, txTrialRequest, txTrialAnswer, txTrialApprove,
           txTrialCancel, txTrialEnergise, txTrialComplete, txTrialReIsolate };
`)((_db, coll, id) => sdkDoc(DB, coll, id), arrayUnion);

const testEnv = await initializeTestEnvironment({
  projectId: "nrcc-flow-test",
  firestore: { rules: fs.readFileSync(path.join(root, "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 }
});

const AT = "2026-08-01T09:00:00.000Z";
const USERS = {
  amir:  { role: "requester", active: true, name: "Amir" },   // crew on pA — asks
  bilal: { role: "requester", active: true, name: "Bilal" },  // crew on pB — clears
  zara:  { role: "requester", active: true, name: "Zara" },   // no permit here
  sara:  { role: "issuer",    active: true, name: "Sara" },
  imran: { role: "isolator",  active: true, name: "Imran" },
  adnan: { role: "admin",     active: true, name: "Adnan" }
};
// What actorStamp() builds in the app, for whoever is signed in.
const actorOf = (uid, roleOverride) => ({ uid, name: USERS[uid].name,
  role: roleOverride || USERS[uid].role, jobTitle: "", department: "", employeeNumber: "" });

async function seed(certOver = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc0(db, "meta", "init"), { done: true });
    for (const [uid, u] of Object.entries(USERS)) await setDoc(doc0(db, "users", uid), u);
    await setDoc(doc0(db, "equipment", "EQ1"), { tag: "P-101A", isolationStatus: "isolated", activeIsolationId: "C1" });
    for (const [id, owner] of [["pA", "amir"], ["pB", "bilal"]])
      await setDoc(doc0(db, "permits", id), { permitNo: "PTW-" + id, status: "active", equipmentRef: "EQ1",
        isolationRef: "C1", requester: { uid: owner, name: USERS[owner].name }, createdAt: AT });
    await setDoc(doc0(db, "isolations", "C1"), { isoNo: "ISO-1", status: "active", equipmentRef: "EQ1",
      equipmentTag: "P-101A", attachedPermitIds: ["pA", "pB"], points: [{ point: "MCC" }], ...certOver });
  });
}
const doc0 = (db, coll, id) => sdkDoc(db, coll, id);
const BASE = { isoId: "C1", equipmentId: "EQ1", knownIds: ["pA", "pB"] };

// Drive one shipped transaction core exactly as the app's wrapper does, but
// signed in as `uid` — optionally lying about the role, as a tampered client
// would. Returns "ok", "gate" (the app refused) or "denied" (the server did).
async function step(uid, core, args, roleLie) {
  const db = testEnv.authenticatedContext(uid).firestore();
  DB = db;
  try {
    await runTransaction(db, (tx) => mod[core](tx, { ...BASE, ...args, actor: actorOf(uid, roleLie), at: AT }));
    return "ok";
  } catch (e) {
    if (e instanceof mod.GateError) return "gate";
    if (String(e).includes("permission-denied") || String(e).includes("PERMISSION_DENIED")) return "denied";
    return "error: " + String(e).split("\n")[0];
  }
}
async function readCert() {
  DB = testEnv.authenticatedContext("adnan").firestore();
  return (await getDoc(sdkDoc(DB, "isolations", "C1"))).data();
}
async function readEquip() {
  DB = testEnv.authenticatedContext("adnan").firestore();
  return (await getDoc(sdkDoc(DB, "equipment", "EQ1"))).data();
}

let pass = 0, fail = 0;
function is(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }
async function expect(name, got, want) {
  const r = await got;
  is(`${name}${r === want ? "" : ` — got ${r}, wanted ${want}`}`, r === want);
}

/* ============ 1. The whole thing, start to finish ============ */
console.log("\nA trial run runs end to end through the shipped transactions:");
await seed();
await expect("the crew raises it", step("amir", "txTrialRequest", { permitId: "pA", reason: "prove the seal" }), "ok");
{
  const c = await readCert();
  is("the certificate carries the request", c.trialRun?.status === "requested");
  is("the certificate is still ACTIVE — nothing is energised", c.status === "active");
}
await expect("the other crew clears it", step("bilal", "txTrialAnswer", { permitId: "pB", decision: "consent" }), "ok");
is("the answer is recorded", (await readCert()).trialRun.consents.length === 2);
await expect("the Issuer authorises", step("sara", "txTrialApprove", {}), "ok");
{
  const c = await readCert();
  is("the stage is approved", c.trialRun.status === "approved");
  is("the equipment is STILL isolated at this point", (await readEquip()).isolationStatus === "isolated");
}
await expect("the Isolator removes the locks", step("imran", "txTrialEnergise", {}), "ok");
{
  const c = await readCert();
  is("the certificate goes to trialRun", c.status === "trialRun");
  is("the equipment is energised", (await readEquip()).isolationStatus === "trialRun");
  is("the Isolator is on the record", c.trialRun.deisolatedBy.uid === "imran");
}
// The crew tells the Isolator the trial has served its purpose. The equipment
// stays live until the Isolator acts — this is a signal, not a state change.
await expect("the crew signs the trial off", step("amir", "txTrialComplete", { remarks: "seal holding" }), "ok");
{
  const c = await readCert();
  is("the sign-off is on the record", c.trialRun.completedBy.uid === "amir");
  is("the equipment is STILL energised after the sign-off", (await readEquip()).isolationStatus === "trialRun");
  is("the certificate is still in trialRun", c.status === "trialRun");
}
await expect("the Isolator puts them back", step("imran", "txTrialReIsolate", {}), "ok");
{
  const c = await readCert();
  is("the certificate is active again", c.status === "active");
  is("the request is cleared", c.trialRun === null);
  is("the completed run is in the log", c.trialRunLog.length === 1 && c.trialRunLog[0].outcome === "completed");
  is("the equipment is isolated again", (await readEquip()).isolationStatus === "isolated");
  is("hand-back can proceed — the lockout survived the trial", c.attachedPermitIds.length === 2);
}

/* ============ 2. The other two endings ============ */
console.log("\nRefusing and cancelling also survive the rules:");
await seed();
await step("amir", "txTrialRequest", { permitId: "pA", reason: "x" });
await expect("a crew refuses", step("bilal", "txTrialAnswer", { permitId: "pB", decision: "refuse", remarks: "fitters inside" }), "ok");
{
  const c = await readCert();
  is("the request is gone", c.trialRun === null);
  is("the refusal is logged", c.trialRunLog[0].outcome === "refused");
}
await seed();
await step("amir", "txTrialRequest", { permitId: "pA", reason: "x" });
await expect("the crew that asked cancels", step("amir", "txTrialCancel", { reason: "not needed" }), "ok");
is("the cancellation is logged", (await readCert()).trialRunLog[0].outcome === "cancelled");
await seed();
await step("amir", "txTrialRequest", { permitId: "pA", reason: "x" });
await expect("an Issuer may also cancel", step("sara", "txTrialCancel", {}), "ok");

// Cancelling AFTER authorisation but before the locks come out — the certificate
// is still active, so this stays a crew-reachable write.
await seed();
await step("amir", "txTrialRequest", { permitId: "pA", reason: "x" });
await step("bilal", "txTrialAnswer", { permitId: "pB", decision: "consent" });
await step("sara", "txTrialApprove", {});
await expect("the crew can still call off an authorised trial", step("amir", "txTrialCancel", { reason: "changed our mind" }), "ok");
{
  const c = await readCert();
  is("nothing was energised on the way out", c.status === "active" && c.trialRun === null);
  is("the authorised-but-unused run is logged", c.trialRunLog[0].outcome === "cancelled");
  is("the Issuer's signature is preserved in the log", c.trialRunLog[0].issuerApproval.uid === "sara");
}

/* ============ 3. A tampered client ============ */
console.log("\nA modified app that lies about its role is stopped by the server:");
await seed();
await step("amir", "txTrialRequest", { permitId: "pA", reason: "x" });
await step("bilal", "txTrialAnswer", { permitId: "pB", decision: "consent" });
await step("sara", "txTrialApprove", {});
// The core takes the signer's role as an argument, so the app's own check is
// satisfied by simply claiming to be an Isolator. Only the rules can refuse.
await expect("an Issuer claiming the Isolator role cannot energise",
  step("sara", "txTrialEnergise", {}, "isolator"), "denied");
await expect("the crew claiming the Isolator role cannot energise",
  step("amir", "txTrialEnergise", {}, "isolator"), "denied");
is("the equipment was never energised", (await readEquip()).isolationStatus === "isolated");
await expect("an Admin genuinely may", step("adnan", "txTrialEnergise", {}), "ok");
await expect("an Issuer claiming Isolator cannot re-isolate either",
  step("sara", "txTrialReIsolate", {}, "isolator"), "denied");
// The sign-off is the one crew write made while the plant is live, so check a
// tampered client cannot ride it into anything more.
await expect("a bystander claiming the asking crew cannot sign the trial off",
  step("zara", "txTrialComplete", {}), "gate");

console.log("\nAnd one that lies about whose crew it speaks for:");
await seed();
await step("amir", "txTrialRequest", { permitId: "pA", reason: "x" });
// zara holds no permit on this lockout. The core would refuse her too, so the
// lie has to be that she is answering for pB — which the rules check against
// the permit document itself.
await expect("a bystander cannot clear the trial for someone else's crew",
  step("zara", "txTrialAnswer", { permitId: "pB", decision: "consent" }), "gate");
is("no answer was recorded", (await readCert()).trialRun.consents.length === 1);
await expect("nor can a crew raise a request naming another crew's permit",
  step("zara", "txTrialRequest", { permitId: "pA", reason: "x" }), "gate");

await testEnv.cleanup();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
