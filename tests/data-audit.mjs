/* Checks the read-only data audit finds the inconsistencies it claims to, and
   — just as important — stays quiet on healthy data. A noisy audit gets
   ignored, and an audit that misses an orphaned lockout is worse than none.

   Runs the shipped auditData() source lifted out of app.js.
   Run: node tests/data-audit.mjs                                            */
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
const CONSTS = ["AUDIT_LIVE_PERMIT", "AUDIT_LIVE_CERT"]
  .map((n) => src.slice(src.indexOf(`const ${n} =`), src.indexOf("];", src.indexOf(`const ${n} =`)) + 2)).join("\n");

const { auditData } = new Function(`
  ${STATUS_LABEL_SRC}
  ${CONSTS}
  ${grab("function auditData(permits, isolations, equipment)")}
  return { auditData };
`)();

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }
const ids = (f) => f.map((x) => x.id).sort();
const of = (f, id) => f.find((x) => x.id === id);

/* ---------------- healthy data must produce silence ---------------- */
console.log("\nHealthy data:");
{
  const eq = [
    { id: "e1", tag: "P-101", isolationStatus: "isolated", activeIsolationId: "c1" },
    { id: "e2", tag: "P-102", isolationStatus: "available", activeIsolationId: null },
    { id: "e3", tag: "P-103", isolationStatus: "available" }                       // field absent
  ];
  const iso = [
    { id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "active" },
    { id: "c0", isoNo: "ISO-0", equipmentRef: "e2", status: "removed" }            // history
  ];
  const p = [
    { id: "p1", permitNo: "PTW-1", equipmentRef: "e1", status: "active", isolationRef: "c1" },
    { id: "p2", permitNo: "PTW-2", equipmentRef: "e2", status: "submitted", isolationRef: null },
    { id: "p3", permitNo: "PTW-3", equipmentRef: "e2", status: "closed", isolationRef: "c0" },
    { id: "p4", permitNo: "PTW-4", equipmentRef: "e3", status: "draft", isolationRef: null }
  ];
  check("nothing reported on a consistent database", auditData(p, iso, eq).length === 0);
}

/* ---------------- the Tier 3 blocker ---------------- */
console.log("\nOrphaned lockout (the finding this audit exists for):");
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "isolated", activeIsolationId: "c2" }];
  const iso = [
    { id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "active" },   // the orphan
    { id: "c2", isoNo: "ISO-2", equipmentRef: "e1", status: "active" }    // the current one
  ];
  const p = [{ id: "p1", permitNo: "PTW-1", equipmentRef: "e1", status: "active", isolationRef: "c1" }];
  const f = auditData(p, iso, eq);
  check("live permit on a non-current certificate is critical", of(f, "orphanHeld")?.severity === "critical");
  check("the orphaned certificate itself is reported", of(f, "orphanCert")?.items.length === 1);
  check("the current certificate is NOT reported", of(f, "orphanCert")?.items[0].label.includes("ISO-1"));
  check("the permit is linked for follow-up", of(f, "orphanHeld")?.items[0].view === "detail");
}
{
  // A permit whose certificate has been removed is finished with it, not orphaned.
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "available", activeIsolationId: null }];
  const iso = [{ id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "removed" }];
  const p = [{ id: "p1", permitNo: "PTW-1", equipmentRef: "e1", status: "active", isolationRef: "c1" }];
  check("a removed certificate is not an orphan", !of(auditData(p, iso, eq), "orphanHeld"));
}
{
  // Closed work on an old certificate is history, not a live orphan.
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "available", activeIsolationId: null }];
  const iso = [{ id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "active" }];
  const p = [{ id: "p1", permitNo: "PTW-1", equipmentRef: "e1", status: "closed", isolationRef: "c1" }];
  const f = auditData(p, iso, eq);
  check("a closed permit is not flagged as held", !of(f, "orphanHeld"));
  check("…but its still-active certificate is", of(f, "orphanCert")?.items.length === 1);
}

/* ---------------- pointer and status problems ---------------- */
console.log("\nPointers and status:");
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "isolated", activeIsolationId: "gone" }];
  const f = auditData([], [], eq);
  check("pointer to a missing certificate is reported", of(f, "stalePointer")?.items.length === 1);
  check("…as a warning, not critical", of(f, "stalePointer")?.severity === "warning");
}
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "isolated", activeIsolationId: "c1" }];
  const iso = [{ id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "removed" }];
  check("pointer to a removed certificate is reported", of(auditData([], iso, eq), "stalePointer")?.items.length === 1);
}
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "available", activeIsolationId: "c1" }];
  const iso = [{ id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "active" }];
  check("says available while holding a live certificate", of(auditData([], iso, eq), "statusMismatch")?.items.length === 1);
}
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "isolated", activeIsolationId: null }];
  check("says isolated with no certificate at all", of(auditData([], [], eq), "statusMismatch")?.items.length === 1);
}

/* ---------------- broken references ---------------- */
console.log("\nBroken references:");
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "available", activeIsolationId: null }];
  const p = [{ id: "p1", permitNo: "PTW-1", equipmentRef: "e1", status: "active", isolationRef: "ghost" }];
  check("permit pointing at a missing certificate", of(auditData(p, [], eq), "danglingIso")?.items.length === 1);
}
{
  const p = [{ id: "p1", permitNo: "PTW-1", equipmentRef: "ghost", status: "active", isolationRef: null }];
  check("permit pointing at missing equipment", of(auditData(p, [], []), "danglingEquip")?.items.length === 1);
  check("…and is not miscounted as an orphaned lockout", !of(auditData(p, [], []), "orphanHeld"));
}
{
  const iso = [{ id: "c1", isoNo: "ISO-1", equipmentRef: "ghost", status: "active" }];
  const f = auditData([], iso, []);
  check("live certificate pointing at missing equipment", of(f, "certNoEquip")?.items.length === 1);
  check("…and is not double-reported as orphaned", !of(f, "orphanCert"));
}

/* ---------------- shape ---------------- */
console.log("\nOutput shape:");
{
  const eq = [{ id: "e1", tag: "P-101", isolationStatus: "isolated", activeIsolationId: "c2" }];
  const iso = [{ id: "c1", isoNo: "ISO-1", equipmentRef: "e1", status: "active" },
               { id: "c2", isoNo: "ISO-2", equipmentRef: "e1", status: "active" }];
  const p = [{ id: "p1", permitNo: "PTW-1", equipmentRef: "e1", status: "active", isolationRef: "c1" }];
  const f = auditData(p, iso, eq);
  check("every finding carries id/severity/title/why/items",
    f.every((x) => x.id && x.severity && x.title && x.why && Array.isArray(x.items) && x.items.length));
  check("severities are only critical or warning", f.every((x) => ["critical", "warning"].includes(x.severity)));
  check("no empty finding groups are emitted", f.every((x) => x.items.length > 0));
  check("finding ids are unique", new Set(ids(f)).size === ids(f).length);
}
{
  check("empty database is silent", auditData([], [], []).length === 0);
  check("missing collections do not throw", auditData([], [], undefined).length === 0);
}

console.log("\nTrial-run drift — the app telling two stories about one machine:");
{
  const eq = (id, over = {}) => ({ id, tag: "P-" + id, isolationStatus: "isolated", activeIsolationId: "C1", ...over });
  const iso = (id, over = {}) => ({ id, isoNo: "ISO-" + id, status: "active", equipmentRef: "EQ1", equipmentTag: "P-EQ1", ...over });
  const ids = (f, id) => (f.find((x) => x.id === id)?.items || []).map((i) => i.label).sort().join(",");

  // Energising moves three records at once. Half-applied, the register and the
  // certificate disagree about whether a machine is live.
  {
    const f = auditData([], [iso("C1")], [eq("EQ1", { isolationStatus: "trialRun" })]);
    check("equipment energised with no trial on its certificate is critical",
      ids(f, "trialEqNotCert") === "P-EQ1" &&
      f.find((x) => x.id === "trialEqNotCert").severity === "critical");
  }
  {
    const f = auditData([], [iso("C1", { status: "trialRun" })], [eq("EQ1", { isolationStatus: "trialRun" })]);
    check("a properly energised pair is not a finding",
      !f.some((x) => x.id === "trialEqNotCert" || x.id === "trialCertNotEq"));
  }
  {
    // The dangerous direction: the register says safe, the certificate says live.
    const f = auditData([], [iso("C1", { status: "trialRun" })], [eq("EQ1")]);
    check("a certificate in a trial whose equipment reads isolated is critical",
      ids(f, "trialCertNotEq") === "ISO-C1" &&
      f.find((x) => x.id === "trialCertNotEq").severity === "critical");
  }
  {
    // A request left on a removed certificate can never be actioned.
    const f = auditData([], [iso("C1", { status: "removed", trialRun: { status: "requested" } })], [eq("EQ1")]);
    check("a trial on a dead certificate is flagged", ids(f, "trialOnDeadCert") === "ISO-C1");
    const ok = auditData([], [iso("C1", { trialRun: { status: "requested" } })], [eq("EQ1")]);
    check("a trial on a live certificate is not", !ok.some((x) => x.id === "trialOnDeadCert"));
  }
  {
    // The earlier flow's residue: a permit log still claiming ENERGISED.
    const p = { id: "p1", permitNo: "PTW-1", status: "active", isolationRef: "C1",
                trialRuns: [{ status: "open" }] };
    const f = auditData([p], [iso("C1")], [eq("EQ1")]);
    check("a stranded permit-side trial log is flagged", ids(f, "trialStranded") === "PTW-1");
    const live = auditData([p], [iso("C1", { status: "trialRun" })], [eq("EQ1", { isolationStatus: "trialRun" })]);
    check("but not while that certificate really is energised",
      !live.some((x) => x.id === "trialStranded"));
  }
  {
    const f = auditData([], [iso("C1")], [eq("EQ1")]);
    check("a quiet plant reports no trial-run drift at all",
      !f.some((x) => x.id.startsWith("trial")));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
