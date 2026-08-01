/* The trial-run security rules, executed against the Firestore emulator.

   Every other suite in this directory tests decisions the CLIENT makes. This
   one tests the decisions the SERVER makes, which is the only layer a modified
   or replayed client cannot talk its way past. It matters here more than
   anywhere else in the app: the crew-facing half of the trial-run workflow is
   the first time a plain requester is allowed to write to an isolation
   certificate at all.

   What is asserted:
     - a requester can raise, clear, refuse and cancel a trial run
     - and can do NOTHING else to the certificate: not the status, not the
       points, not another crew's answer, not the Issuer's signature
     - only an Isolator can energise or re-isolate; an Issuer cannot, whatever
       the client sends
     - the trial-run history is append-only for every role, Admins included

   Requires the emulator. Run:
     node_modules/.bin/firebase emulators:exec --only firestore \
       --project nrcc-rules-test "node tests/rules-trial-run.mjs"           */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteField } from "firebase/firestore";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const testEnv = await initializeTestEnvironment({
  projectId: "nrcc-rules-test",
  firestore: { rules: fs.readFileSync(path.join(root, "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 }
});

let pass = 0, fail = 0;
async function check(name, promise) {
  try { await promise; pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e).split("\n")[0]}`); }
}
const allow = (name, op) => check(name, assertSucceeds(op));
const deny = (name, op) => check(name, assertFails(op));

/* ---------------- fixtures ---------------- */
const AT = "2026-08-01T09:00:00.000Z";
const USERS = {
  amir:  { role: "requester", active: true, name: "Amir" },   // crew A — asks
  bilal: { role: "requester", active: true, name: "Bilal" },  // crew B — must clear
  zara:  { role: "requester", active: true, name: "Zara" },   // no permit here
  sara:  { role: "issuer",    active: true, name: "Sara" },
  imran: { role: "isolator",  active: true, name: "Imran" },
  adnan: { role: "admin",     active: true, name: "Adnan" }
};
const permit = (owner, over = {}) => ({
  permitNo: "PTW-" + owner, status: "active", equipmentRef: "EQ1", isolationRef: "C1",
  requester: { uid: owner, name: USERS[owner].name }, createdAt: AT, ...over
});
const CERT = { isoNo: "ISO-1", status: "active", equipmentRef: "EQ1", equipmentTag: "P-101A",
               attachedPermitIds: ["pA", "pB"], points: [{ point: "MCC", method: "lock" }] };
const consent = (uid, permitId, decision) => ({ permitId, permitNo: "PTW-" + uid, uid, name: USERS[uid].name, decision, at: AT });
const request = (over = {}) => ({
  status: "requested", permitId: "pA", permitNo: "PTW-amir", reason: "prove the seal",
  requestedBy: { uid: "amir", name: "Amir" }, requestedAt: AT,
  consents: [consent("amir", "pA", "requested")], issuerApproval: null, ...over
});

// Reset to a known world before every scenario, bypassing rules.
async function seed(certOver = {}, permitOver = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "meta", "init"), { done: true });
    for (const [uid, u] of Object.entries(USERS)) await setDoc(doc(db, "users", uid), u);
    await setDoc(doc(db, "equipment", "EQ1"), { tag: "P-101A", isolationStatus: "isolated", activeIsolationId: "C1" });
    await setDoc(doc(db, "permits", "pA"), permit("amir"));
    await setDoc(doc(db, "permits", "pB"), { ...permit("bilal"), ...permitOver });
    await setDoc(doc(db, "isolations", "C1"), { ...CERT, ...certOver });
  });
}
const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const cert = (uid) => doc(as(uid), "isolations", "C1");

/* ================= 1. Raising a request ================= */
console.log("\nA crew may ask for a trial run on the lockout holding them:");
await seed();
await allow("the permit's own requester raises it",
  updateDoc(cert("amir"), { trialRun: request() }));
await seed();
await deny("a signed-in user with no permit on this lockout cannot",
  updateDoc(cert("zara"), { trialRun: request({ permitId: "pA", requestedBy: { uid: "zara", name: "Zara" } }) }));
await seed();
await deny("nor by naming someone else's permit as the asker",
  updateDoc(cert("zara"), { trialRun: request({ requestedBy: { uid: "zara", name: "Zara" } }) }));
await seed();
await deny("a crew cannot raise it in another crew's name",
  updateDoc(cert("bilal"), { trialRun: request() }));
await seed();
await deny("a request cannot arrive pre-authorised",
  updateDoc(cert("amir"), { trialRun: request({ issuerApproval: { uid: "sara", at: AT } }) }));
await seed();
await deny("a request cannot arrive already approved",
  updateDoc(cert("amir"), { trialRun: request({ status: "approved" }) }));
await seed();
await deny("a request cannot arrive already ENERGISED",
  updateDoc(cert("amir"), { trialRun: request({ status: "energised" }) }));
await seed();
await deny("a request cannot carry other crews' consents already given",
  updateDoc(cert("amir"), { trialRun: request({ consents: [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")] }) }));
await seed({}, { status: "closed" });
await deny("a closed permit is not a crew and cannot ask",
  updateDoc(cert("bilal"), { trialRun: request({ permitId: "pB", requestedBy: { uid: "bilal", name: "Bilal" } }) }));
await seed({ status: "removalPending" });
await deny("a certificate in hand-back takes no requests",
  updateDoc(cert("amir"), { trialRun: request() }));

/* ================= 2. Clearing it ================= */
console.log("\nEach crew answers for itself and for nobody else:");
await seed({ trialRun: request() });
await allow("the other crew clears the trial",
  updateDoc(cert("bilal"), { "trialRun.consents": [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")] }));
await seed({ trialRun: request() });
await deny("a bystander cannot clear it",
  updateDoc(cert("zara"), { "trialRun.consents": [consent("amir", "pA", "requested"), consent("zara", "pB", "consent")] }));
await seed({ trialRun: request() });
await deny("a crew cannot forge another crew's consent",
  updateDoc(cert("amir"), { "trialRun.consents": [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")] }));
await seed({ trialRun: request() });
await deny("an answer cannot be slipped in while deleting an earlier one",
  updateDoc(cert("bilal"), { "trialRun.consents": [consent("bilal", "pB", "consent")] }));
await seed({ trialRun: request() });
await deny("two answers cannot be added at once",
  updateDoc(cert("bilal"), { "trialRun.consents": [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent"), consent("zara", "pB", "consent")] }));
await seed({ trialRun: request() });
await deny("clearing cannot also authorise the trial",
  updateDoc(cert("bilal"), { "trialRun.consents": [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")],
    "trialRun.issuerApproval": { uid: "bilal", at: AT } }));
await seed({ trialRun: request() });
await deny("clearing cannot also move the stage",
  updateDoc(cert("bilal"), { "trialRun.consents": [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")],
    "trialRun.status": "approved" }));

/* ================= 3. Ending it before anything is live ================= */
console.log("\nRefusing and cancelling are open to the people they belong to:");
await seed({ trialRun: request() });
await allow("a crew refuses",
  updateDoc(cert("bilal"), { trialRun: null, trialRunLog: [{ ...request(), outcome: "refused", status: "closed",
    closedBy: { uid: "bilal", name: "Bilal" }, closedAt: AT,
    consents: [consent("amir", "pA", "requested"), consent("bilal", "pB", "refuse")] }] }));
await seed({ trialRun: request() });
await deny("a bystander cannot refuse on a crew's behalf",
  updateDoc(cert("zara"), { trialRun: null, trialRunLog: [{ ...request(), outcome: "refused", status: "closed",
    closedBy: { uid: "zara", name: "Zara" }, closedAt: AT,
    consents: [consent("amir", "pA", "requested"), consent("zara", "pB", "refuse")] }] }));
await seed({ trialRun: request() });
await allow("the crew that asked cancels it",
  updateDoc(cert("amir"), { trialRun: null, trialRunLog: [{ ...request(), outcome: "cancelled", status: "closed",
    closedBy: { uid: "amir", name: "Amir" }, closedAt: AT }] }));
await seed({ trialRun: request() });
await deny("another crew cannot cancel someone else's request",
  updateDoc(cert("bilal"), { trialRun: null, trialRunLog: [{ ...request(), outcome: "cancelled", status: "closed",
    closedBy: { uid: "bilal", name: "Bilal" }, closedAt: AT }] }));
await seed({ trialRun: request() });
await deny("the record cannot be dropped without a log entry",
  updateDoc(cert("amir"), { trialRun: null }));
await seed({ trialRun: request() });
await deny("the closing signature cannot name someone else",
  updateDoc(cert("amir"), { trialRun: null, trialRunLog: [{ ...request(), outcome: "cancelled", status: "closed",
    closedBy: { uid: "sara", name: "Sara" }, closedAt: AT }] }));

/* ================= 4. The certificate itself stays shut ================= */
console.log("\nA crew can reach the trial run and nothing else on the certificate:");
await seed({ trialRun: request({ status: "approved", issuerApproval: { uid: "sara", name: "Sara", at: AT },
  consents: [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")] }) });
await deny("a crew cannot ENERGISE the equipment, however clear the trial is",
  updateDoc(cert("amir"), { status: "trialRun", "trialRun.status": "energised" }));
await deny("nor authorise their own trial run",
  updateDoc(cert("amir"), { "trialRun.status": "approved", "trialRun.issuerApproval": { uid: "amir", at: AT } }));
await deny("nor rewrite the isolation points",
  updateDoc(cert("amir"), { points: [] }));
await deny("nor release the certificate",
  updateDoc(cert("amir"), { status: "removed" }));
await deny("nor attach their permit to another lockout",
  updateDoc(cert("amir"), { attachedPermitIds: ["pA", "pB", "pZ"] }));
await deny("nor smuggle a field change alongside a legitimate trial write",
  updateDoc(cert("amir"), { trialRun: null, attachedPermitIds: [],
    trialRunLog: [{ ...request(), outcome: "cancelled", status: "closed", closedBy: { uid: "amir" }, closedAt: AT }] }));
await deny("a crew cannot delete the certificate", (async () => {
  const { deleteDoc } = await import("firebase/firestore");
  return deleteDoc(cert("amir"));
})());

/* ================= 5. Only the Isolator energises ================= */
console.log("\nEnergising and re-isolating stay with the Isolator:");
const APPROVED = request({ status: "approved", issuerApproval: { uid: "sara", name: "Sara", at: AT },
  consents: [consent("amir", "pA", "requested"), consent("bilal", "pB", "consent")] });
await seed({ trialRun: APPROVED });
await allow("an Isolator removes the locks",
  updateDoc(cert("imran"), { status: "trialRun", "trialRun.status": "energised",
    "trialRun.deisolatedBy": { uid: "imran", name: "Imran" }, "trialRun.deisolatedAt": AT }));
// Found by this suite: canIssue() reached every status change that was not
// assigned → active, so an Issuer could energise isolated equipment directly.
// The UI never offered it and the transaction refused it — the server did not.
await seed({ trialRun: APPROVED });
await deny("an ISSUER cannot remove the locks, whatever the client sends",
  updateDoc(cert("sara"), { status: "trialRun", "trialRun.status": "energised",
    "trialRun.deisolatedBy": { uid: "sara", name: "Sara" }, "trialRun.deisolatedAt": AT }));
await seed({ status: "trialRun", trialRun: { ...APPROVED, status: "energised" } });
await deny("nor declare it re-isolated afterwards",
  updateDoc(cert("sara"), { status: "active", trialRun: null,
    trialRunLog: [{ ...APPROVED, status: "closed", outcome: "completed", reIsolatedBy: { uid: "sara" }, reIsolatedAt: AT }] }));
await seed({ trialRun: APPROVED });
await allow("an Admin still can, as the system superuser",
  updateDoc(cert("adnan"), { status: "trialRun", "trialRun.status": "energised",
    "trialRun.deisolatedBy": { uid: "adnan", name: "Adnan" }, "trialRun.deisolatedAt": AT }));
// Releasing a certificate stays an Issuer power — that is deliberate and
// unchanged; only the two trial transitions moved.
await seed();
await allow("an Issuer can still release a certificate",
  updateDoc(cert("sara"), { status: "removed", removedAt: AT }));
await seed({ trialRun: APPROVED });
await deny("the crew that asked certainly cannot",
  updateDoc(cert("amir"), { status: "trialRun", "trialRun.status": "energised" }));
await seed({ status: "trialRun", trialRun: { ...APPROVED, status: "energised" } });
await allow("an Isolator puts them back",
  updateDoc(cert("imran"), { status: "active", trialRun: null,
    trialRunLog: [{ ...APPROVED, status: "closed", outcome: "completed", reIsolatedBy: { uid: "imran" }, reIsolatedAt: AT }] }));
await seed({ status: "trialRun", trialRun: { ...APPROVED, status: "energised" } });
await deny("a crew cannot declare the equipment re-isolated",
  updateDoc(cert("amir"), { status: "active", trialRun: null,
    trialRunLog: [{ ...APPROVED, status: "closed", outcome: "completed", reIsolatedBy: { uid: "amir" }, reIsolatedAt: AT }] }));
await seed({ trialRun: request() });
await allow("an Issuer authorises a cleared request",
  updateDoc(cert("sara"), { "trialRun.status": "approved", "trialRun.issuerApproval": { uid: "sara", name: "Sara", at: AT } }));

/* ========= 5b. The crew's sign-off, the one write made while live ========= */
console.log("\nThe crew may say the trial is finished while the plant is live:");
const LIVE = { ...APPROVED, status: "energised", deisolatedBy: { uid: "imran", name: "Imran" }, deisolatedAt: AT };
const signOff = (uid) => ({ "trialRun.completedBy": { uid, name: USERS[uid].name },
  "trialRun.completedAt": AT, "trialRun.completionRemarks": "seal holding" });
await seed({ status: "trialRun", trialRun: LIVE });
await allow("the crew that asked signs it off", updateDoc(cert("amir"), signOff("amir")));
await seed({ status: "trialRun", trialRun: LIVE });
await deny("another crew cannot sign for them", updateDoc(cert("bilal"), signOff("bilal")));
await seed({ status: "trialRun", trialRun: LIVE });
await deny("a bystander certainly cannot", updateDoc(cert("zara"), signOff("zara")));
await seed({ status: "trialRun", trialRun: LIVE });
await deny("nor can a crew sign in someone else's name", updateDoc(cert("amir"), signOff("bilal")));
// The whole point: it is a request for re-isolation, not re-isolation.
await seed({ status: "trialRun", trialRun: LIVE });
await deny("signing off cannot also re-isolate the certificate",
  updateDoc(cert("amir"), { ...signOff("amir"), status: "active" }));
await seed({ status: "trialRun", trialRun: LIVE });
await deny("nor move the trial out of energised",
  updateDoc(cert("amir"), { ...signOff("amir"), "trialRun.status": "closed" }));
await seed({ status: "trialRun", trialRun: LIVE });
await deny("nor rewrite who took the locks out",
  updateDoc(cert("amir"), { ...signOff("amir"), "trialRun.deisolatedBy": { uid: "amir", name: "Amir" } }));
await seed({ status: "trialRun", trialRun: LIVE });
await deny("nor rewrite the consents that justified it",
  updateDoc(cert("amir"), { ...signOff("amir"), "trialRun.consents": [] }));
await seed({ status: "trialRun", trialRun: { ...LIVE, completedBy: { uid: "amir", name: "Amir" }, completedAt: AT } });
await deny("a sign-off cannot be overwritten once given", updateDoc(cert("amir"), signOff("amir")));
// Before the locks are out there is nothing to sign off.
await seed({ trialRun: APPROVED });
await deny("an authorised-but-not-energised trial cannot be signed off",
  updateDoc(cert("amir"), signOff("amir")));

/* ================= 6. The history cannot be edited ================= */
console.log("\nThe trial-run log is append-only for everyone:");
const OLD = [{ ...request(), status: "closed", outcome: "completed", reIsolatedAt: AT }];
await seed({ trialRunLog: OLD });
await deny("a crew cannot erase the history",
  updateDoc(cert("amir"), { trialRunLog: [] }));
await seed({ trialRunLog: OLD });
await deny("an Issuer cannot erase it either",
  updateDoc(cert("sara"), { trialRunLog: [] }));
await seed({ trialRunLog: OLD });
await deny("an ADMIN cannot erase it either",
  updateDoc(cert("adnan"), { trialRunLog: [] }));
await seed({ trialRunLog: OLD });
await deny("an Issuer cannot rewrite an entry",
  updateDoc(cert("sara"), { trialRunLog: [{ ...OLD[0], outcome: "cancelled" }] }));
await seed({ trialRunLog: OLD });
await deny("nor drop the field entirely",
  updateDoc(cert("sara"), { trialRunLog: deleteField() }));
await seed({ trialRunLog: OLD });
await allow("an Issuer may still append to it",
  updateDoc(cert("sara"), { trialRunLog: [...OLD, { ...request(), status: "closed", outcome: "cancelled",
    closedBy: { uid: "sara" }, closedAt: AT }] }));

/* ================= 7. The legacy permit-side cleanup ================= */
console.log("\nAn Isolator can close out a trial recorded by the earlier flow:");
await seed({}, { trialRuns: [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: null, status: "open" }] });
await allow("the Isolator closes the stranded permit entry",
  updateDoc(doc(as("imran"), "permits", "pB"),
    { trialRuns: [{ authorisedBy: "Admin", authorisedAt: AT, reIsolatedAt: AT, status: "closed" }], updatedAt: AT }));
await seed({}, { trialRuns: [{ status: "open" }] });
await deny("but cannot ride that path to change the permit's status",
  updateDoc(doc(as("imran"), "permits", "pB"), { trialRuns: [], status: "closed", updatedAt: AT }));
await seed({}, { trialRuns: [{ status: "open" }] });
await deny("nor to stamp a work completion",
  updateDoc(doc(as("imran"), "permits", "pB"), { trialRuns: [], workCompletion: { name: "x" }, updatedAt: AT }));
await seed({}, { trialRuns: [{ status: "open" }] });
await deny("a crew cannot touch another crew's permit this way",
  updateDoc(doc(as("amir"), "permits", "pB"), { trialRuns: [], updatedAt: AT }));

await testEnv.cleanup();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
