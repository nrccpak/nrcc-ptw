/* Verifies the live-collection Store never serves data it cannot vouch for.
   The cached copy is only ever a speed/cost optimisation — every path that
   cannot be trusted must fall back to a direct server read, which is the old
   behaviour: slower, never wrong.

   Runs the real Store + fetchAll source lifted out of app.js against mocked
   Firestore primitives, so these assertions exercise shipped code.
   Run: node tests/store-freshness.mjs                                       */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

// Slice a declaration out of app.js. `skipParams` is needed for functions whose
// parameter list itself contains braces (destructured options like
// `{ fresh = false } = {}`) — otherwise brace counting would close on the
// parameters instead of the body.
function slice(startSig, skipParams = false) {
  const i = src.indexOf(startSig);
  if (i < 0) throw new Error("not found in app.js: " + startSig);
  let j = i;
  if (skipParams) {
    let p = 0, seen = false;
    for (; j < src.length; j++) {
      if (src[j] === "(") { p++; seen = true; }
      else if (src[j] === ")") { p--; if (seen && p === 0) { j++; break; } }
    }
  }
  let d = 0, started = false;
  for (; j < src.length; j++) {
    if (src[j] === "{") { d++; started = true; }
    else if (src[j] === "}") { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced: " + startSig);
}

// --- mocked Firestore ---
const listeners = {};          // coll -> {onNext, onErr}
let getDocsCalls = [];
const mock = {
  collection: (_db, coll) => coll,
  onSnapshot: (coll, onNext, onErr) => {
    listeners[coll] = { onNext, onErr };
    return () => { delete listeners[coll]; };
  },
  getDocs: async (coll) => {
    getDocsCalls.push(coll);
    return { docs: [{ id: "server-" + coll, data: () => ({ from: "server" }) }] };
  }
};
const deliver = (coll, docs) =>
  listeners[coll].onNext({ docs: docs.map((d) => ({ id: d.id, data: () => d })) });
const failListener = (coll, err) => listeners[coll].onErr(err);

const env = new Function("collection", "onSnapshot", "getDocs", "console", `
  const db = {};
  ${slice("const Store = {")}
  ${slice("async function fetchAll(coll,", true)}
  return { Store, fetchAll };
`)(mock.collection, mock.onSnapshot, mock.getDocs, { warn() {} });

const { Store, fetchAll } = env;

let pass = 0, fail = 0;
function ok(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }
const reset = () => { getDocsCalls = []; };

console.log("\nA collection is not trusted until its listener has delivered:");
Store.start(["permits"]);
ok("before first delivery, memory is not served", Store.get("permits") === null);
reset();
ok("…so a read goes to the server", (await fetchAll("permits"))[0].id === "server-permits" && getDocsCalls.length === 1);
deliver("permits", [{ id: "p1", status: "submitted" }]);
ok("after delivery, memory is served", Store.get("permits")?.[0].id === "p1");
reset();
ok("…and the read costs nothing", (await fetchAll("permits"))[0].id === "p1" && getDocsCalls.length === 0);

console.log("\nA dropped listener must stop being trusted:");
failListener("permits", new Error("permission-denied"));
ok("memory is no longer served", Store.get("permits") === null);
reset();
ok("reads fall back to the server", (await fetchAll("permits"))[0].id === "server-permits" && getDocsCalls.length === 1);
ok("a recovered listener is trusted again", (deliver("permits", [{ id: "p2" }]), Store.get("permits")?.[0].id === "p2"));

console.log("\nAfter a write, the next read must not draw the pre-write state:");
Store.markStale("permits");
ok("memory is withheld once marked stale", Store.get("permits") === null);
reset();
ok("…so the read goes to the server", (await fetchAll("permits"))[0].id === "server-permits" && getDocsCalls.length === 1);
deliver("permits", [{ id: "p3" }]);
ok("the next listener push clears the stale flag", Store.get("permits")?.[0].id === "p3");

console.log("\nSafety gates can demand a server read even when memory is good:");
reset();
ok("fresh:true bypasses a healthy copy", (await fetchAll("permits", { fresh: true }))[0].id === "server-permits" && getDocsCalls.length === 1);
ok("…and leaves the copy intact for other callers", Store.get("permits")?.[0].id === "p3");

console.log("\nCallers must not be able to corrupt the shared copy:");
const handed = await fetchAll("permits");
handed.push({ id: "injected" });
ok("the array handed out is a copy", Store.get("permits").length === 1);

console.log("\nA late subscriber catches up immediately:");
let sawDocs = null;
Store.onChange("permits", (docs) => { sawDocs = docs; });
ok("onChange fires straight away when already live", sawDocs?.[0].id === "p3");

console.log("\nSigning out drops the previous user's data:");
Store.stop();
ok("memory is cleared", Store.get("permits") === null);
ok("the listener is detached", Object.keys(listeners).length === 0);
reset();
ok("reads go to the server again", (await fetchAll("permits"))[0].id === "server-permits" && getDocsCalls.length === 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
