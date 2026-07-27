/* Verifies the approval-path preconditions added for the stale-page races.
   Runs the real helper source lifted out of app.js against a simulated
   Firestore transaction, so the assertions exercise shipped code, not a copy.
   Run: node tests/approval-race.mjs                                        */
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

// Build the helpers with a stubbed `doc()` and no real Firestore.
const mod = new Function("docStub", `
  const doc = docStub, db = {};
  ${STATUS_LABEL_SRC}
  ${grab("class GateError extends Error")}
  ${grab("function gate(msg)")}
  ${grab("async function txPermitAwaitingDecision(tx, permitId)")}
  ${grab("async function txEquipmentPointer(tx, equipmentId, expected)")}
  return { GateError, txPermitAwaitingDecision, txEquipmentPointer };
`)((_db, coll, id) => ({ coll, id }));

// --- simulated transaction over a plain document store ---
const store = () => ({ permits: {}, equipment: {}, isolations: {} });
const mkTx = (s) => ({
  get: async (ref) => {
    const d = s[ref.coll]?.[ref.id];
    return { exists: () => !!d, data: () => d, id: ref.id };
  }
});

let pass = 0, fail = 0;
async function check(name, fn, expect) {
  let got = "ok";
  try { await fn(); } catch (e) { got = e instanceof mod.GateError ? "gate" : "error:" + e.message; }
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : `  (expected ${expect}, got ${got})`}`);
}

console.log("\nPermit must still be awaiting a decision:");
{
  const s = store();
  s.permits.p1 = { status: "submitted" };
  s.permits.p2 = { status: "active" };      // another Issuer already approved
  s.permits.p3 = { status: "rejected" };
  s.permits.p4 = { status: "closed" };
  const tx = mkTx(s);
  await check("submitted permit approves", () => mod.txPermitAwaitingDecision(tx, "p1"), "ok");
  await check("already-approved permit refuses", () => mod.txPermitAwaitingDecision(tx, "p2"), "gate");
  await check("rejected permit refuses", () => mod.txPermitAwaitingDecision(tx, "p3"), "gate");
  await check("closed permit refuses", () => mod.txPermitAwaitingDecision(tx, "p4"), "gate");
  await check("deleted permit refuses", () => mod.txPermitAwaitingDecision(tx, "gone"), "gate");
}

console.log("\nEquipment certificate pointer must match what the dialog assumed:");
{
  const s = store();
  s.equipment.free = { activeIsolationId: null };
  s.equipment.claimed = { activeIsolationId: "isoA" };
  const tx = mkTx(s);
  // THE Tier 2 scenario: page loaded with no certificate; another Issuer's
  // approval created one before this Issuer clicked Approve.
  await check("create-cert on equipment claimed meanwhile REFUSES",
    () => mod.txEquipmentPointer(tx, "claimed", null), "gate");
  await check("create-cert on still-free equipment proceeds",
    () => mod.txEquipmentPointer(tx, "free", null), "ok");
  await check("attach to the certificate still in place proceeds",
    () => mod.txEquipmentPointer(tx, "claimed", "isoA"), "ok");
  await check("attach when a DIFFERENT certificate took over refuses",
    () => mod.txEquipmentPointer(tx, "claimed", "isoB"), "gate");
  await check("attach when the isolation was removed meanwhile refuses",
    () => mod.txEquipmentPointer(tx, "free", "isoA"), "gate");
  await check("missing equipment refuses", () => mod.txEquipmentPointer(tx, "gone", null), "gate");
}

console.log("\nField-shape tolerance (older records may omit activeIsolationId):");
{
  const s = store();
  s.equipment.legacy = {};                       // field absent entirely
  s.equipment.explicitNull = { activeIsolationId: null };
  const tx = mkTx(s);
  await check("absent pointer treated as 'no certificate'",
    () => mod.txEquipmentPointer(tx, "legacy", null), "ok");
  await check("absent pointer still refuses an attach", 
    () => mod.txEquipmentPointer(tx, "legacy", "isoA"), "gate");
  await check("explicit null treated the same",
    () => mod.txEquipmentPointer(tx, "explicitNull", null), "ok");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
