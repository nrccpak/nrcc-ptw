/* The order of the dashboard's "Active work" card. The card shows the first
   DASH_ROWS of a live queue and drops the rest, so the sort decides what an
   Issuer sees and what they never do. Two properties matter:

     - overdue permits come first, whatever their dates
     - within a group, the one closest to its planned end leads

   Runs the shipped comparator lifted out of app.js.
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
  ${grab("function permitEnd(p)")}
  ${grab("function isOverdue(p)")}
  ${grab("function byAttention(a, b)")}
  return { DASH_ROWS, byAttention };
`)();
const { DASH_ROWS, byAttention } = M;

const HOUR = 3600000;
const iso = (hrs) => new Date(Date.now() + hrs * HOUR).toISOString();
// A live permit ending in `hrs` hours (negative = already past, so overdue).
const p = (permitNo, hrs, status = "active") =>
  ({ permitNo, status, validity: hrs === null ? { openEnded: true } : { plannedEnd: iso(hrs) } });
const order = (list) => [...list].sort(byAttention).map((x) => x.permitNo);

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

console.log("\nThe card shows 12 rows:");
check("DASH_ROWS is 12", DASH_ROWS === 12);

console.log("\nOverdue permits lead, whatever else is in the list:");
{
  const list = [p("SOON", 1), p("LATE", -30), p("LATER", 200), p("JUST-OVER", -0.5)];
  const o = order(list);
  check("both overdue come first", o.slice(0, 2).every((n) => n === "LATE" || n === "JUST-OVER"));
  check("most overdue leads", o[0] === "LATE");
  check("the rest follow by nearest end", o.slice(2).join() === "SOON,LATER");
}

console.log("\nWithin the live group, the nearest deadline leads:");
{
  check("ordered by planned end", order([p("C", 72), p("A", 2), p("B", 30)]).join() === "A,B,C");
}

console.log("\nAn extended permit is judged on its extended end, not the original:");
{
  const extended = { permitNo: "EXT", status: "extended", validity: { plannedEnd: iso(-40), extendedTo: iso(48) } };
  const o = order([extended, p("SOON", 3)]);
  check("extending clears the overdue flag", o.join() === "SOON,EXT");
}

console.log("\nOpen-ended permits sort last, not first:");
{
  // permitEnd returns null for these; a null date must not read as "year zero".
  const o = order([{ permitNo: "OPEN", status: "active", validity: { openEnded: true } }, p("DATED", 500)]);
  check("no deadline is not the nearest deadline", o.join() === "DATED,OPEN");
  const o2 = order([{ permitNo: "OPEN", status: "active", validity: { openEnded: true } }, p("LATE", -5)]);
  check("still behind an overdue permit", o2.join() === "LATE,OPEN");
}

console.log("\nMalformed records sink rather than jumping the queue:");
{
  const o = order([{ permitNo: "NODATES", status: "active" }, p("SOON", 4)]);
  check("a permit with no validity block sorts last", o.join() === "SOON,NODATES");
  const o2 = order([{ permitNo: "JUNK", status: "active", validity: { plannedEnd: "tomorrow-ish" } }, p("SOON", 4)]);
  check("an unparseable end date sorts last", o2.join() === "SOON,JUNK");
}

console.log("\nThe truncation keeps the urgent end of the list:");
{
  // 20 permits, one of them long overdue and raised long ago: the case the
  // old newest-first order pushed off the bottom of the card.
  const many = [];
  for (let n = 0; n < 19; n++) many.push(p("NEW" + n, 100 + n));
  many.push(p("FORGOTTEN", -400));
  const shown = [...many].sort(byAttention).slice(0, DASH_ROWS).map((x) => x.permitNo);
  check("the forgotten permit is on the card, and first", shown[0] === "FORGOTTEN");
  check("the card is capped", shown.length === DASH_ROWS);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
