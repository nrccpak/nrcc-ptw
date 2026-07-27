/* The live-refresh guards. A repaint that fires at the wrong moment is worse
   than a stale screen: it can move a button out from under a thumb, or let a
   screen the user has already left write over its replacement.

   Runs the shipped LiveView source lifted out of app.js.
   Run: node tests/live-view.mjs                                             */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

const i = src.indexOf("const LiveView = {");
if (i < 0) throw new Error("LiveView not found in app.js");
let d = 0, started = false, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === "{") { d++; started = true; }
  else if (src[j] === "}") { d--; if (started && d === 0) { end = j + 1; break; } }
}
const LIVEVIEW_SRC = src.slice(i, end);

// $ is used only to look for an open dialog.
let modalHtml = "";
const { LiveView } = new Function("$", `${LIVEVIEW_SRC}\nreturn { LiveView };`)(
  (sel) => (sel === "#modal-root" ? { innerHTML: modalHtml } : null)
);

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 600;              // comfortably past the 400ms debounce

let pass = 0, fail = 0;
function check(name, cond) { cond ? pass++ : fail++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}`); }

console.log("\nA bound view repaints when data changes:");
{
  modalHtml = "";
  const token = LiveView.reset();
  let painted = 0;
  LiveView.bind(token, () => { painted++; });
  LiveView.ping();
  await tick(SETTLE);
  check("one ping repaints once", painted === 1);
}

console.log("\nBursts collapse into a single repaint:");
{
  modalHtml = "";
  const token = LiveView.reset();
  let painted = 0;
  LiveView.bind(token, () => { painted++; });
  for (let n = 0; n < 10; n++) LiveView.ping();
  await tick(SETTLE);
  check("ten rapid changes repaint once, not ten times", painted === 1);
}

console.log("\nNothing moves while a dialog is open:");
{
  modalHtml = `<div class="modal">Approve permit?</div>`;
  const token = LiveView.reset();
  let painted = 0;
  LiveView.bind(token, () => { painted++; });
  LiveView.ping();
  await tick(SETTLE);
  check("no repaint while a decision is in progress", painted === 0);
  // …and the screen is not left permanently frozen once the dialog closes.
  modalHtml = "";
  LiveView.ping();
  await tick(SETTLE);
  check("repaints again once the dialog is closed", painted === 1);
}
{
  // Whitespace-only markup is an empty modal root, not an open dialog.
  modalHtml = "\n  ";
  const token = LiveView.reset();
  let painted = 0;
  LiveView.bind(token, () => { painted++; });
  LiveView.ping();
  await tick(SETTLE);
  check("blank modal markup does not count as an open dialog", painted === 1);
}

console.log("\nA view the user has left never repaints:");
{
  modalHtml = "";
  const token = LiveView.reset();
  let painted = 0;
  LiveView.bind(token, () => { painted++; });
  LiveView.ping();
  LiveView.reset();                       // navigation, mid-debounce
  await tick(SETTLE);
  check("a pending repaint is cancelled by navigation", painted === 0);
}
{
  modalHtml = "";
  const stale = LiveView.token;
  LiveView.reset();                       // navigated before this view finished loading
  let painted = 0;
  LiveView.bind(stale, () => { painted++; });
  LiveView.ping();
  await tick(SETTLE);
  check("a view that finished loading too late declines to register", painted === 0);
}
{
  modalHtml = "";
  const token = LiveView.reset();
  let painted = 0;
  LiveView.bind(token, () => { painted++; });
  LiveView.ping();
  await tick(SETTLE);
  check("…and the current view still repaints normally", painted === 1);
}

console.log("\nNo view bound means nothing happens:");
{
  modalHtml = "";
  LiveView.reset();
  LiveView.ping();
  await tick(SETTLE);
  check("ping with nothing bound is a no-op", true);   // absence of a throw
}

console.log("\nA failing repaint does not break later ones:");
{
  modalHtml = "";
  const token = LiveView.reset();
  let painted = 0;
  const orig = console.warn; console.warn = () => {};
  LiveView.bind(token, () => { painted++; throw new Error("render blew up"); });
  LiveView.ping();
  await tick(SETTLE);
  LiveView.ping();
  await tick(SETTLE);
  console.warn = orig;
  check("a throwing repaint is caught and the next one still runs", painted === 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
