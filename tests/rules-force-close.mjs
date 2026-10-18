/* The Admin force-close security rules, executed against the Firestore emulator.

   tests/force-close.mjs checks the decisions the CLIENT makes. This checks what
   the SERVER enforces on forceRequests, which a modified client cannot talk its
   way past:
     - only an Admin can raise a request, and only with a reason, a category and
       a checklist, on a live permit, once the waiting period has passed by
       SERVER time
     - only an Issuer other than the Admin who asked can decide it, a rejection
       needs a comment, and an approval is also held to the waiting period
     - a decision cannot rewrite the request itself
     - the Admin may withdraw their own pending request, nobody else's
     - nothing is ever deleted

   Also proved: an Issuer's approving transaction can actually perform each of
   the three actions under the existing rules — the workflow is no use if the
   second signer is forbidden from writing the permit.

   Requires the emulator. Run:
     node_modules/.bin/firebase emulators:exec --only firestore \
       --project nrcc-rules-test "node tests/rules-force-close.mjs"          */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from "firebase/firestore";

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

const DAY = 86400000;
const OLD = () => Date.now() - 11 * DAY;     // past the waiting period
const FRESH = () => Date.now() - 3 * DAY;    // not yet
const AT = "2026-08-01T09:00:00.000Z";
const USERS = {
  adnan: { role: "admin", active: true, name: "Adnan" },
  adam:  { role: "admin", active: true, name: "Adam" },
  sara:  { role: "issuer", active: true, name: "Sara" },
  sami:  { role: "issuer", active: true, name: "Sami" },
  imran: { role: "isolator", active: true, name: "Imran" },
  amir:  { role: "requester", active: true, name: "Amir" }
};
const CHECKS = ["Work area inspected and confirmed safe", "All personnel accounted for and out of the area",
  "Tools and materials removed", "All locks and tags verified removed or accounted for"];
const REASON = "Requester left site; nobody else can sign off the job";
const req = (over = {}) => ({
  permitId: "pA", permitNo: "PTW-amir", action: "workComplete", category: "unavailable", reason: REASON, checks: CHECKS,
  status: "pending", anchorMs: OLD(), requestedBy: { uid: "adnan", name: "Adnan", role: "admin" }, requestedAt: AT,
  decision: null, ...over
});
const decision = (uid, comment = "") => ({ by: uid, name: USERS[uid].name, role: USERS[uid].role, comment, at: AT });

async function seed({ permit = {}, request = null, cert = {} } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "meta", "init"), { done: true });
    for (const [uid, u] of Object.entries(USERS)) await setDoc(doc(db, "users", uid), u);
    await setDoc(doc(db, "equipment", "EQ1"), { tag: "P-101A", isolationStatus: "isolated", activeIsolationId: "C1" });
    await setDoc(doc(db, "permits", "pA"), {
      permitNo: "PTW-amir", status: "active", equipmentRef: "EQ1", isolationRef: "C1",
      requester: { uid: "amir", name: "Amir" }, approval: { issuerUid: "sara" }, createdAt: AT, ...permit
    });
    await setDoc(doc(db, "isolations", "C1"), { isoNo: "ISO-1", status: "active", equipmentRef: "EQ1", attachedPermitIds: ["pA"], ...cert });
    if (request) await setDoc(doc(db, "forceRequests", "R1"), request);
  });
}
const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const fr = (uid) => doc(as(uid), "forceRequests", "R1");

/* ================= 1. Raising ================= */
console.log("\nOnly an Admin can raise a request:");
await seed();
await allow("an Admin raises one", setDoc(fr("adnan"), req()));
for (const who of ["sara", "imran", "amir"]) {
  await seed();
  await deny(`${USERS[who].role} cannot`, setDoc(fr(who), req({ requestedBy: { uid: who, name: USERS[who].name } })));
}
await seed();
await deny("an Admin cannot raise one in another Admin's name", setDoc(fr("adnan"), req({ requestedBy: { uid: "adam", name: "Adam" } })));

console.log("\nWhat a request must contain:");
for (const [name, over] of [
  ["a reason shorter than 20 characters", { reason: "no one around" }],
  ["no category", { category: "" }],
  ["an unknown category", { category: "bored" }],
  ["an unknown action", { action: "explode" }],
  ["an incomplete checklist", { checks: CHECKS.slice(0, 2) }],
  ["no anchor for the waiting period", { anchorMs: undefined }],
  ["arriving already approved", { status: "approved" }],
  ["arriving with a decision on it", { decision: decision("sara") }]
]) {
  await seed();
  const data = req(over); if ("anchorMs" in over && over.anchorMs === undefined) delete data.anchorMs;
  await deny(`refused: ${name}`, setDoc(fr("adnan"), data));
}

console.log("\nThe waiting period is measured by the server's clock:");
await seed();
await deny("a request anchored 3 days ago is refused", setDoc(fr("adnan"), req({ anchorMs: FRESH() })));
await seed();
await deny("an anchor in the future is refused", setDoc(fr("adnan"), req({ anchorMs: Date.now() + DAY })));
await seed();
await allow("one anchored 11 days ago is allowed", setDoc(fr("adnan"), req({ anchorMs: OLD() })));

console.log("\nOnly on a live permit:");
for (const status of ["closed", "rejected", "draft", "expired"]) {
  await seed({ permit: { status } });
  await deny(`a ${status} permit is refused`, setDoc(fr("adnan"), req()));
}
await seed({ permit: { status: "extended" } });
await allow("an extended permit is allowed", setDoc(fr("adnan"), req()));
await seed();
await deny("a permit that does not exist is refused", setDoc(fr("adnan"), req({ permitId: "nope" })));

/* ================= 2. Deciding ================= */
console.log("\nDeciding:");
await seed({ request: req() });
await allow("an Issuer approves", updateDoc(fr("sara"), { status: "approved", decision: decision("sara"), executedAt: AT }));
await seed({ request: req() });
await allow("another Issuer can too", updateDoc(fr("sami"), { status: "approved", decision: decision("sami"), executedAt: AT }));
await seed({ request: req() });
await allow("an Issuer rejects with a comment", updateDoc(fr("sara"), { status: "rejected", decision: decision("sara", "Requester is back") }));
await seed({ request: req() });
await deny("a rejection without a comment is refused", updateDoc(fr("sara"), { status: "rejected", decision: decision("sara", "") }));
for (const who of ["adnan", "adam"]) {
  await seed({ request: req() });
  await deny(`an Admin (${who}) cannot approve — not even their own`, updateDoc(fr(who), { status: "approved", decision: decision(who), executedAt: AT }));
}
for (const who of ["imran", "amir"]) {
  await seed({ request: req() });
  await deny(`${USERS[who].role} cannot decide`, updateDoc(fr(who), { status: "approved", decision: decision(who), executedAt: AT }));
}
await seed({ request: req() });
await deny("an Issuer cannot sign the decision as someone else", updateDoc(fr("sara"), { status: "approved", decision: decision("sami"), executedAt: AT }));
await seed({ request: req() });
await deny("a decision cannot rewrite the reason", updateDoc(fr("sara"), { status: "approved", decision: decision("sara"), reason: "something else entirely, as it were" }));
await seed({ request: req() });
await deny("nor the checklist", updateDoc(fr("sara"), { status: "approved", decision: decision("sara"), checks: [] }));
await seed({ request: req() });
await deny("nor the action", updateDoc(fr("sara"), { status: "approved", decision: decision("sara"), action: "close" }));
await seed({ request: req({ status: "approved", decision: decision("sara") }) });
await deny("a decided request cannot be decided again", updateDoc(fr("sami"), { status: "rejected", decision: decision("sami", "no") }));
await seed({ request: req({ anchorMs: FRESH() }) });
await deny("approval is held to the waiting period too", updateDoc(fr("sara"), { status: "approved", decision: decision("sara"), executedAt: AT }));
await seed({ request: req({ anchorMs: FRESH() }) });
await allow("…but a rejection is not", updateDoc(fr("sara"), { status: "rejected", decision: decision("sara", "not needed") }));

console.log("\nWithdrawing:");
await seed({ request: req() });
await allow("the Admin who raised it can withdraw it", updateDoc(fr("adnan"), { status: "void" }));
await seed({ request: req() });
await deny("another Admin cannot", updateDoc(fr("adam"), { status: "void" }));
await seed({ request: req() });
await deny("an Issuer cannot", updateDoc(fr("sara"), { status: "void" }));
await seed({ request: req() });
await deny("withdrawing cannot also change the reason", updateDoc(fr("adnan"), { status: "void", reason: "a quite different reason entirely" }));
await seed({ request: req({ status: "approved", decision: decision("sara") }) });
await deny("a carried-out request cannot be withdrawn", updateDoc(fr("adnan"), { status: "void" }));

console.log("\nReading and deleting:");
await seed({ request: req() });
await allow("an active user can read a request", getDoc(fr("amir")));
await seed({ request: req() });
for (const who of ["adnan", "sara"]) await deny(`${USERS[who].role} cannot delete one`, deleteDoc(fr(who)));

/* ================= 3. The second signer can carry the action out ================= */
console.log("\nThe Issuer's approving transaction is permitted to perform each action:");
const done = { workCompletion: { by: "adnan", name: "Adnan", forced: { reason: REASON } } };
await seed();
await allow("force work-complete: Issuer stamps the completion on the permit",
  updateDoc(doc(as("sara"), "permits", "pA"), { forcePending: null, updatedAt: AT, workCompletion: done.workCompletion.by ? done.workCompletion : null }));
await seed({ permit: done });
await allow("force de-isolation: Issuer removes the certificate",
  updateDoc(doc(as("sara"), "isolations", "C1"), { status: "removed", removedAt: AT, removalConfirmedBy: { uid: "adnan" }, forced: { reason: REASON } }));
await seed({ permit: done });
await allow("…and returns the equipment to service",
  updateDoc(doc(as("sara"), "equipment", "EQ1"), { isolationStatus: "available", activeIsolationId: null, updatedAt: AT }));
await seed({ permit: done, cert: { status: "removed" } });
await allow("force close: Issuer closes the permit",
  updateDoc(doc(as("sara"), "permits", "pA"), { status: "closed", closure: { by: "adnan", forced: { reason: REASON } }, forcePending: null, updatedAt: AT }));
await seed();
await allow("the Admin can flag the permit when raising a request",
  updateDoc(doc(as("adnan"), "permits", "pA"), { forcePending: { requestId: "R1", action: "workComplete", at: AT }, "force.anchorMs": OLD() }));

await testEnv.cleanup();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
