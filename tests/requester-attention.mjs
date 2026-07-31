/* What the Requester's own dashboard card puts in front of them. Their card
   used to be titled "recent" and left in fetch order — newest first, capped at
   twelve rows — which is precisely the order that hides a permit they have
   forgotten about, and past twelve rows hides it altogether.

   A Requester can act on exactly two things, and both are easy to walk away
   from because nothing chases them:

     - a draft they never submitted
     - a live permit whose job they never confirmed finished, which leaves the
       equipment isolated with nobody waiting on anybody

   Runs the shipped helpers lifted out of app.js.
   Run: node tests/requester-attention.mjs                                   */
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
  ${grabLine("const DASH_ROWS =")}
  ${grabLine("const PERMIT_STALE_DAYS =")}
  ${grabLine("const PERMIT_LONG_STALE_DAYS =")}
  ${grabLine("function permitLiveSince(p)")}
  ${grab("function staleLevel(since)")}
  ${grab("function awaitsRequester(p)")}
  ${grab("function requesterWaitSince(p)")}
  ${grab("function byOwnAttention(a, b)")}
  return { DASH_ROWS, PERMIT_STALE_DAYS, PERMIT_LONG_STALE_DAYS, staleLevel, awaitsRequester, requesterWaitSince, byOwnAttention };
`)();
const { DASH_ROWS, PERMIT_STALE_DAYS, PERMIT_LONG_STALE_DAYS,
  staleLevel, awaitsRequester, requesterWaitSince, byOwnAttention } = M;

const DAY = 86400000;
const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();

const draft = (permitNo, days) => ({ permitNo, status: "draft", createdAt: daysAgo(days + 5), updatedAt: daysAgo(days) });
const working = (permitNo, days) => ({ permitNo, status: "active", approval: { timestamp: daysAgo(days) } });
const signedOff = (permitNo, days) => ({ ...working(permitNo, days), workCompletion: { timestamp: daysAgo(0.5) } });
const submitted = (permitNo, days) => ({ permitNo, status: "submitted", createdAt: daysAgo(days), updatedAt: daysAgo(days) });
const closed = (permitNo, days) => ({ permitNo, status: "closed", approval: { timestamp: daysAgo(days) }, workCompletion: { timestamp: daysAgo(days) } });
// The dashboard hands this list over already newest-first, as the fetch leaves it.
const order = (list) => [...list].sort(byOwnAttention).map((x) => x.permitNo);

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

console.log("\nOnly what the Requester can actually move counts as theirs:");
{
  check("an unsubmitted draft is theirs", awaitsRequester(draft("D", 1)));
  check("a live job not yet confirmed complete is theirs", awaitsRequester(working("W", 1)));
  check("an extended permit counts the same as an active one",
    awaitsRequester({ status: "extended", approval: { timestamp: daysAgo(1) } }));
  check("once they confirm the work, it is not theirs", !awaitsRequester(signedOff("S", 1)));
  check("submitted is the Issuer's move, not theirs", !awaitsRequester(submitted("U", 1)));
  check("awaiting isolation is the Isolator's move", !awaitsRequester({ status: "awaitingIsolation" }));
  check("closed is nobody's", !awaitsRequester(closed("C", 1)));
  check("rejected is nobody's", !awaitsRequester({ status: "rejected" }));
  check("a missing record does not throw", !awaitsRequester(null));
}

console.log("\nTheirs comes first, longest-waiting at the top:");
{
  const o = order([working("FRESH", 1), draft("OLD-DRAFT", 30), working("MID", 9)]);
  check("oldest of theirs leads", o.join() === "OLD-DRAFT,MID,FRESH");
}
{
  // The whole point: a forgotten permit outranks everything newer, whatever
  // status the newer ones are in.
  const o = order([closed("CLOSED-TODAY", 0.1), submitted("SENT-TODAY", 0.1), working("FORGOTTEN", 60)]);
  check("a 60-day unconfirmed job leads a card full of today's activity", o[0] === "FORGOTTEN");
}

console.log("\nEverything else keeps the order it arrived in:");
{
  // The fetch delivers newest first; below the attention group that is the
  // right way to read history, so the sort must leave it alone.
  const o = order([closed("NEWEST", 1), submitted("MIDDLE", 5), closed("OLDEST", 40)]);
  check("no reshuffling of what is not theirs", o.join() === "NEWEST,MIDDLE,OLDEST");
}
{
  const o = order([closed("C1", 1), working("MINE", 3), submitted("S1", 2)]);
  check("theirs is lifted out without disturbing the rest", o.join() === "MINE,C1,S1");
}

console.log("\nA draft's clock restarts when they touch it:");
{
  const stale = draft("STALE", 20);                     // raised 25 d ago, last saved 20 d ago
  const edited = { permitNo: "EDITED", status: "draft", createdAt: daysAgo(60), updatedAt: daysAgo(1) };
  check("last save is the clock, not the raise date", requesterWaitSince(edited) === edited.updatedAt);
  check("a draft edited yesterday is not forgotten", staleLevel(requesterWaitSince(edited)) === 0);
  check("one abandoned for 20 days is", staleLevel(requesterWaitSince(stale)) === 1);
  check("and it leads the card", order([edited, stale])[0] === "STALE");
}

console.log("\nA live permit's clock runs from approval, as on the Issuer's card:");
{
  const p = working("W", 10);
  check("approval is the clock", requesterWaitSince(p) === p.approval.timestamp);
  const late = { permitNo: "LATE-DRAFT", status: "active", createdAt: daysAgo(90), approval: { timestamp: daysAgo(2) } };
  check("a permit drafted long before approval is judged from approval",
    staleLevel(requesterWaitSince(late)) === 0);
}

console.log("\nThe row colour uses the same two thresholds as the Issuer's card:");
{
  check("under a week is plain", staleLevel(requesterWaitSince(working("A", PERMIT_STALE_DAYS - 0.1))) === 0);
  check("a week → amber", staleLevel(requesterWaitSince(working("B", PERMIT_STALE_DAYS))) === 1);
  check("three weeks → red", staleLevel(requesterWaitSince(working("C", PERMIT_LONG_STALE_DAYS))) === 2);
  check("an undatable draft is not accused", staleLevel(requesterWaitSince({ status: "draft" })) === 0);
}

console.log("\nThe forgotten permit survives the row cap:");
{
  const many = [];
  for (let n = 0; n < 20; n++) many.push(closed("HISTORY" + n, n * 0.1));
  many.push(draft("FORGOTTEN-DRAFT", 120));
  const shown = [...many].sort(byOwnAttention).slice(0, DASH_ROWS).map((x) => x.permitNo);
  check("it is on the card, and first", shown[0] === "FORGOTTEN-DRAFT");
  check("the card is still capped", shown.length === DASH_ROWS);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
