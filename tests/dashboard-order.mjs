/* The order of the dashboard's "Active work" card, and the staleness rule that
   goes with it. The card shows the first DASH_ROWS of a live queue and drops
   the rest, so the sort decides what an Issuer sees and what they never do.

   The site this runs on raises mostly OPEN-ENDED permits: no planned end, so
   nothing ever falls due and the Overdue flag can never apply. Everything here
   turns on that — elapsed time is the only signal a job has been forgotten.

     - work still in progress leads; permits already in hand-back do not
     - within a group, longest-live first
     - "live" is measured from approval, not from raising the draft

   Runs the shipped helpers lifted out of app.js.
   Run: node tests/dashboard-order.mjs                                       */
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
  ${grabLine("function permitLiveSince(p)")}
  ${grab("function isStale(p)")}
  ${grab("function isoIndex(isolations)")}
  ${grab("function permitStage(p, isolations)")}
  ${grab("function byWorkAge(isolations)")}
  return { DASH_ROWS, PERMIT_STALE_DAYS, permitLiveSince, isStale, isoIndex, byWorkAge };
`)();
const { DASH_ROWS, PERMIT_STALE_DAYS, permitLiveSince, isStale, isoIndex, byWorkAge } = M;

const DAY = 86400000;
const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();

// An open-ended permit, live for `days`, with no isolation — the ordinary case
// on this site. `done` gives it a work-completion sign-off (i.e. hand-back).
const permit = (permitNo, days, done = false) => ({
  permitNo, status: "active",
  validity: { openEnded: true },
  approval: { timestamp: daysAgo(days) },
  ...(done ? { workCompletion: { timestamp: daysAgo(0) } } : {})
});
const order = (list, isos = []) => [...list].sort(byWorkAge(isoIndex(isos))).map((x) => x.permitNo);

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

console.log("\nSite settings:");
check("the card shows 12 rows", DASH_ROWS === 12);
check("stale after 7 days", PERMIT_STALE_DAYS === 7);

console.log("\nLongest-live first, among work still in progress:");
{
  check("oldest leads", order([permit("B", 3), permit("C", 1), permit("A", 20)]).join() === "A,B,C");
  check("open-ended permits still order — no planned end needed",
    order([permit("NEW", 0.2), permit("OLD", 9)]).join() === "OLD,NEW");
}

console.log("\nPermits already in hand-back drop below work in progress:");
{
  // The 30-day permit is finished and waiting on the Issuer — it has its own
  // card, so it must not push a job someone is still standing at off the top.
  const o = order([permit("SIGNED-OFF", 30, true), permit("WORKING", 2)]);
  check("a signed-off permit yields to live work", o.join() === "WORKING,SIGNED-OFF");
  check("it stays on the card rather than vanishing", o.length === 2);
}
{
  // Awaiting de-isolation is hand-back too: work done, locks still on.
  const iso = [{ id: "I1", status: "active" }];
  const held = { permitNo: "HELD", status: "active", validity: { openEnded: true },
    approval: { timestamp: daysAgo(40) }, isolationRef: "I1", workCompletion: { timestamp: daysAgo(1) } };
  check("awaiting de-isolation also yields", order([held, permit("WORKING", 1)], iso).join() === "WORKING,HELD");
}
{
  // Within the hand-back group the same age rule applies.
  const o = order([permit("RECENT", 2, true), permit("ANCIENT", 60, true)]);
  check("hand-back rows are ordered oldest first too", o.join() === "ANCIENT,RECENT");
}

console.log("\nDeadlines play no part — the overdue banner above carries those:");
{
  const overdueSoon = { permitNo: "OVERDUE-YESTERDAY", status: "active",
    validity: { plannedEnd: daysAgo(1) }, approval: { timestamp: daysAgo(2) } };
  check("a 2-day overdue permit does not outrank a 30-day open-ended one",
    order([overdueSoon, permit("OLD-OPEN", 30)]).join() === "OLD-OPEN,OVERDUE-YESTERDAY");
}

console.log("\n'Live for' is measured from approval, not from raising the draft:");
{
  const p = { permitNo: "X", createdAt: daysAgo(40), approval: { timestamp: daysAgo(2) } };
  check("approval wins over createdAt", permitLiveSince(p) === p.approval.timestamp);
  check("a draft that sat for 38 days is not a 40-day-old job", !isStale(p));
  const legacy = { permitNo: "OLD-RECORD", createdAt: daysAgo(10), validity: { start: daysAgo(9) } };
  check("records with no approval stamp fall back", permitLiveSince(legacy) === legacy.validity.start);
  check("and are still judged stale on that fallback", isStale(legacy));
}

console.log("\nThe stale chip lands on the forgotten, not on everything:");
{
  check("a day-old job is not stale", !isStale(permit("A", 1)));
  check("just under the line", !isStale(permit("B", PERMIT_STALE_DAYS - 0.1)));
  check("exactly on the line", isStale(permit("C", PERMIT_STALE_DAYS)));
  check("months old", isStale(permit("D", 90)));
  check("undatable records are not accused", !isStale({ permitNo: "?" }));
}

console.log("\nUndatable permits sink rather than claiming to be the oldest:");
{
  check("no timestamps at all sorts last",
    order([{ permitNo: "NODATE", status: "active" }, permit("OLD", 5)]).join() === "OLD,NODATE");
}

console.log("\nThe truncation keeps the forgotten end of the list:");
{
  // 19 jobs raised today plus one running since last month — the case the old
  // newest-first order pushed off the bottom of the card.
  const many = [];
  for (let n = 0; n < 19; n++) many.push(permit("TODAY" + n, 0.1));
  many.push(permit("FORGOTTEN", 45));
  const shown = [...many].sort(byWorkAge(isoIndex([]))).slice(0, DASH_ROWS).map((x) => x.permitNo);
  check("the forgotten permit is on the card, and first", shown[0] === "FORGOTTEN");
  check("the card is capped", shown.length === DASH_ROWS);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
