/* The dashboard queue tiles' escalation rule. The tile is the only thing that
   tells an Issuer or Isolator that work is piling up, so two properties matter
   and neither is visible from reading the CSS:

     - a queue goes red at exactly QUEUE_ALERT_HRS, measured from the OLDEST
       item, not the newest and not the average
     - the clock starts when the item landed on that person's desk, which for
       every one of the four queues is a different field

   Runs the shipped helpers lifted out of app.js.
   Run: node tests/queue-attention.mjs                                       */
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
  ${grabLine("const QUEUE_ALERT_HRS =")}
  ${grab("function ageText(iso)")}
  ${grab("const laterOf = (a, b) =>")}
  ${grab("function queueState(items, since, alertHrs = QUEUE_ALERT_HRS)")}
  return { QUEUE_ALERT_HRS, ageText, laterOf, queueState };
`)();

const { QUEUE_ALERT_HRS, ageText, laterOf, queueState } = M;
const HOUR = 3600000;
const agoISO = (hrs) => new Date(Date.now() - hrs * HOUR).toISOString();
const at = (x) => x;                       // items are their own timestamps

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

console.log("\nAn empty queue is calm, not green-lit or alarmed:");
{
  const s = queueState([], at);
  check("no items → calm", s.tone === "calm");
  check("calm carries no age to show", s.oldest === undefined);
}

console.log(`\nThe threshold is the configured ${QUEUE_ALERT_HRS} h, on the oldest item:`);
{
  check("site threshold is 8 h", QUEUE_ALERT_HRS === 8);
  check("fresh item → warn", queueState([agoISO(1)], at).tone === "warn");
  check("just under the line → warn", queueState([agoISO(QUEUE_ALERT_HRS - 0.05)], at).tone === "warn");
  check("exactly on the line → alert", queueState([agoISO(QUEUE_ALERT_HRS)], at).tone === "alert");
  check("well past → alert", queueState([agoISO(40)], at).tone === "alert");
}

console.log("\nOne stale item alarms the tile even in a crowd of fresh ones:");
{
  const q = [agoISO(0.1), agoISO(0.2), agoISO(30), agoISO(0.3)];
  const s = queueState(q, at);
  check("a 30 h straggler is not averaged away", s.tone === "alert");
  check("the age reported is the oldest", Math.abs(Date.parse(s.oldest) - Date.parse(agoISO(30))) < 2000);
}
{
  // The inverse: the newest must not rescue a queue either.
  check("all stale → alert", queueState([agoISO(9), agoISO(20)], at).tone === "alert");
}

console.log("\nA queue may set its own threshold, and the default stays 8 h:");
{
  // The Requester's tile passes the row threshold (7 days) so that the tile
  // and the rows underneath it can never disagree about what is overdue.
  const sevenDays = 7 * 24;
  check("6 days is nothing on a 7-day queue", queueState([agoISO(6 * 24)], at, sevenDays).tone === "warn");
  check("8 days is too long on a 7-day queue", queueState([agoISO(8 * 24)], at, sevenDays).tone === "alert");
  check("the same 6-day item alarms the default 8 h queue", queueState([agoISO(6 * 24)], at).tone === "alert");
}

console.log("\nItems with no usable timestamp still show as waiting:");
{
  check("undefined date → warn, never calm", queueState([undefined], at).tone === "warn");
  check("junk date → warn, never calm", queueState(["not a date"], at).tone === "warn");
  // A record missing its timestamp must not hide the ones that have theirs.
  check("mixed → still judged on the datable items", queueState([undefined, agoISO(12)], at).tone === "alert");
}

console.log("\nlaterOf picks the moment the permit actually became closable:");
{
  const done = agoISO(10), removed = agoISO(3);
  check("locks came off after the crew signed off", laterOf(done, removed) === removed);
  check("order of the arguments does not matter", laterOf(removed, done) === removed);
  check("no certificate → the crew sign-off stands", laterOf(done, null) === done);
  check("no sign-off → falls through to the other", laterOf(null, removed) === removed);
  check("neither → nothing to date", laterOf(null, undefined) === undefined);
}
{
  // The bug this guards: taking work-completion alone would start the clock
  // while the locks were still on, and blame the Issuer for the wait.
  const s = queueState([{ done: agoISO(20), removed: agoISO(1) }], (p) => laterOf(p.done, p.removed));
  check("de-isolated an hour ago is not an 8 h backlog", s.tone === "warn");
}

console.log("\nAge reads as a duration, not a date:");
{
  check("under a minute", ageText(agoISO(0)) === "just now");
  check("minutes", ageText(agoISO(0.75)) === "45 min");
  check("hours", ageText(agoISO(6)) === "6 h");
  check("rounds down to whole hours", ageText(agoISO(6.9)) === "6 h");
  check("days", ageText(agoISO(50)) === "2 d");
  check("unparseable dates say nothing rather than NaN", ageText(undefined) === "");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
