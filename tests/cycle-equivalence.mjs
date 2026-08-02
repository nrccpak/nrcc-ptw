/* Does the one-document work-cycle model give the same answer as today's
   query-based gate?

   Tier 3 replaces a scan of every permit and certificate with a single field on
   the equipment record, so that availability can be checked inside the
   transaction it guards and enforced in security rules. That is only worth
   doing if the new model agrees with the old one. This harness generates
   equipment populations and compares, per item:

       computeCycleState(buildCycle(...)) === "handback"
   vs  equipmentBlock(...) !== null  OR  the equipment's certificate is
                                         removalPending

   The second disjunct is not part of equipmentBlock: approvePermit refuses
   separately when the equipment's certificate is mid de-isolation, including
   when no permits reference it any more (rejecting the last permit on a
   confirmed certificate leaves the locks on with an empty certificate). The
   cycle model has to cover both, so both are in the oracle.

   Section 1 uses REACHABLE data — states the app can actually produce, with
   live permits referencing the equipment's own certificate. Agreement here is
   required; any failure blocks Tier 3.

   Section 2 deliberately generates malformed data (dangling references,
   orphaned certificates) to find and DOCUMENT where the two models part
   company, since a single-document model cannot see certificates the equipment
   does not point at. Divergences are reported, not asserted away.

   Run: node tests/cycle-equivalence.mjs                                     */
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
  ${grab("function computeCycleState(cycle)")}
  ${grab("function buildCycle(equip, permits, isolations)")}
  return { equipmentBlock, computeCycleState, buildCycle };
`)();

// --- deterministic RNG so a failure can be reproduced ---
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

const LIVE = ["submitted", "awaitingIsolation", "active", "extended"];
const TERMINAL = ["closed", "rejected", "expired"];
const CERT_ST = ["assigned", "active", "trialRun", "removalPending", "removed"];

// The legacy answer: what the app does today, across both places it decides.
function legacyBlocked(equip, permits, isolations) {
  if (M.equipmentBlock(equip.id, permits, isolations, null)) return true;
  const cert = equip.activeIsolationId ? isolations.find((i) => i.id === equip.activeIsolationId) : null;
  return !!(cert && cert.status === "removalPending");   // approvePermit's separate gate
}
const cycleBlocked = (equip, permits, isolations) =>
  M.computeCycleState(M.buildCycle(equip, permits, isolations)) === "handback";

/* ---------- Section 1: reachable states ---------- */
// Builds one equipment item whose data obeys the app's own invariants: at most
// one current certificate, live permits attached to that certificate (or to
// none), work-completion only on live work.
function reachableWorld() {
  const equip = { id: "eq1", tag: "EQ-1", activeIsolationId: null };
  const isolations = [], permits = [];
  let n = 0;

  const hasCert = chance(0.65);
  let cert = null;
  if (hasCert) {
    cert = { id: "isoA", status: pick(CERT_ST), attachedPermitIds: [] };
    isolations.push(cert);
    // A removed certificate is history: the equipment no longer points at it.
    if (cert.status !== "removed") equip.activeIsolationId = cert.id;
  }
  // Historical, already-finished work is always allowed to exist.
  for (let i = 0; i < Math.floor(rnd() * 3); i++) {
    const old = { id: "p" + n++, equipmentRef: equip.id, status: pick(TERMINAL), isolationRef: null, workCompletion: null };
    if (cert && chance(0.5)) { old.isolationRef = cert.id; cert.attachedPermitIds.push(old.id); }
    permits.push(old);
  }
  for (let i = 0; i < Math.floor(rnd() * 4); i++) {
    const status = pick(LIVE);
    const p = { id: "p" + n++, equipmentRef: equip.id, status, isolationRef: null, workCompletion: null };
    // Only an isolation-bearing lifecycle attaches to a certificate, and a
    // permit can only be awaitingIsolation if there is one to wait for.
    if (cert && cert.status !== "removed" && (status === "awaitingIsolation" || chance(0.6))) {
      p.isolationRef = cert.id;
      cert.attachedPermitIds.push(p.id);
    }
    if (["active", "extended"].includes(status) && chance(0.5)) p.workCompletion = { by: "u1" };
    permits.push(p);
  }
  // Noise on OTHER equipment must never influence this item's answer.
  for (let i = 0; i < Math.floor(rnd() * 3); i++)
    permits.push({ id: "x" + n++, equipmentRef: "eqOther", status: pick(LIVE), isolationRef: null, workCompletion: chance(0.5) ? { by: "u" } : null });

  return { equip, permits, isolations };
}

let checked = 0, mismatches = [];
for (let i = 0; i < 40000; i++) {
  const w = reachableWorld();
  const legacy = legacyBlocked(w.equip, w.permits, w.isolations);
  const cycle = cycleBlocked(w.equip, w.permits, w.isolations);
  checked++;
  if (legacy !== cycle) mismatches.push({ legacy, cycle, w });
}

console.log(`\nSection 1 — reachable states`);
console.log(`  worlds compared: ${checked.toLocaleString()}`);
if (mismatches.length === 0) {
  console.log(`  PASS  the cycle model agrees with the live gate on every one`);
} else {
  console.log(`  FAIL  ${mismatches.length} disagreement(s). First 3:`);
  for (const m of mismatches.slice(0, 3)) {
    console.log(`    legacy=${m.legacy} cycle=${m.cycle}`);
    console.log(`    equipment:   ${JSON.stringify(m.w.equip)}`);
    console.log(`    certificates:${JSON.stringify(m.w.isolations)}`);
    console.log(`    permits:     ${JSON.stringify(m.w.permits.filter((p) => p.equipmentRef === "eq1"))}`);
    console.log(`    cycle:       ${JSON.stringify(M.buildCycle(m.w.equip, m.w.permits, m.w.isolations))}\n`);
  }
}

/* ---------- Section 2: malformed data, for documentation ---------- */
// Anything goes: dangling isolationRefs, certificates the equipment does not
// point at, permits attached to removed lockouts.
function chaoticWorld() {
  const equip = { id: "eq1", tag: "EQ-1", activeIsolationId: null };
  const isolations = [];
  for (let i = 0; i < Math.floor(rnd() * 3); i++)
    isolations.push({ id: "iso" + i, status: pick(CERT_ST), attachedPermitIds: [] });
  if (isolations.length && chance(0.7)) equip.activeIsolationId = pick(isolations).id;
  const permits = [];
  for (let i = 0; i < Math.floor(rnd() * 5); i++) {
    const status = pick([...LIVE, ...TERMINAL]);
    permits.push({
      id: "p" + i, equipmentRef: equip.id, status,
      isolationRef: chance(0.6) ? (isolations.length && chance(0.8) ? pick(isolations).id : "ghost") : null,
      workCompletion: chance(0.5) ? { by: "u" } : null
    });
  }
  for (const p of permits) if (p.isolationRef) isolations.find((i) => i.id === p.isolationRef)?.attachedPermitIds.push(p.id);
  return { equip, permits, isolations };
}

const kinds = new Map();
let chaos = 0, chaosDiff = 0;
for (let i = 0; i < 40000; i++) {
  const w = chaoticWorld();
  const legacy = legacyBlocked(w.equip, w.permits, w.isolations);
  const cycle = cycleBlocked(w.equip, w.permits, w.isolations);
  chaos++;
  if (legacy === cycle) continue;
  chaosDiff++;
  // Classify why, so the divergence can be judged rather than just counted.
  const live = w.permits.filter((p) => p.equipmentRef === w.equip.id && LIVE.includes(p.status));
  const refs = new Set(live.map((p) => p.isolationRef).filter(Boolean));
  const dangling = [...refs].some((r) => !w.isolations.some((i) => i.id === r));
  const foreign = [...refs].some((r) => r !== w.equip.activeIsolationId && w.isolations.some((i) => i.id === r));
  const key = `${legacy ? "legacy blocks, cycle allows" : "cycle blocks, legacy allows"}` +
    `${dangling ? " | dangling isolationRef" : ""}${foreign ? " | permit on a certificate the equipment does not point at" : ""}`;
  kinds.set(key, (kinds.get(key) || 0) + 1);
}

console.log(`Section 2 — malformed / legacy data (documentation, not a gate)`);
console.log(`  worlds compared: ${chaos.toLocaleString()}   disagreements: ${chaosDiff.toLocaleString()} (${(100 * chaosDiff / chaos).toFixed(1)}%)`);
for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)}  ${k}`);
if (!kinds.size) console.log(`    none`);

console.log(`\n${mismatches.length === 0 ? "PASS" : "FAIL"} — Section 1 is the gate for Tier 3.\n`);
process.exit(mismatches.length === 0 ? 0 : 1);
