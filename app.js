/* ==============================================================
   NRCC Work Permit System — Application Logic
   Stack: Firebase (Auth + Firestore offline persistence), vanilla JS PWA.
   This file is organised top-to-bottom as:
     1. Firebase init        2. State & helpers     3. Auth/bootstrap
     4. App shell & router   5. Views (dashboard, permits, equipment, admin)
     6. Permit + isolation + trial-run logic   7. PDF/print
   See the Setup & User Manual for how everything fits together.
   ============================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  writeBatch, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, appBranding } from "./firebase-config.js";

/* -------------------- 1. Firebase init -------------------- */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* -------------------- 2. State & helpers -------------------- */
const State = { user: null, profile: null, config: null, view: "dashboard", params: {} };

// Master job-title list (exact order). Stored in config/app so Admins can
// add/remove entries; this is the seed/default when config has none.
const DEFAULT_JOB_TITLES = [
  "Technician", "Foreman", "Supervisor", "CCR Operator", "Shift Engineer",
  "Patrolman", "Engineer", "Chief Engineer", "Manager", "Shift Supervisor",
  "PPM Inspector", "Quality Supervisor", "Lab Technician", "Safety Officer", "Officer"
];

const DEFAULT_CONFIG = {
  permitTypes: [
    { code: "general", name: "General / Cold Work", abbr: "GEN", requiresIsolation: false, requiresGasTest: false,
      checklist: ["Work area inspected and safe", "Correct tools in good condition", "Housekeeping arranged", "Access / egress clear"] },
    { code: "hot", name: "Hot Work", abbr: "HOT", requiresIsolation: false, requiresGasTest: true,
      checklist: ["Fire watch assigned", "Suitable fire extinguisher on site", "Combustibles removed or covered", "Area gas-tested where required", "Hot work stopped 30 min before shift end"] },
    { code: "loto", name: "Electrical Isolation (LOTO)", abbr: "LOTO", requiresIsolation: true, requiresGasTest: false,
      checklist: ["Equipment de-energised", "Locks and tags applied", "Zero-energy state verified", "Stored / residual energy released", "Try-start test done"] },
    { code: "confined", name: "Confined Space Entry", abbr: "CSE", requiresIsolation: true, requiresGasTest: true,
      checklist: ["Gas test completed and acceptable", "Standby person assigned", "Ventilation provided", "Entry / exit log maintained", "Rescue arrangement in place"] }
  ],
  lines: ["Line 1", "Line 2", "Common"],
  areas: ["Crusher", "Stacker", "Raw Mill + Pre-heater", "Kiln", "Cooler", "Cement Mill", "Transport", "Grinding", "Silo", "Packing Plant"],
  departments: [
    { name: "Maintenance", subUnits: ["Mechanical", "PPM", "Electrical", "Instrument / PLC"] },
    { name: "Production", subUnits: [] },
    { name: "Quality Control", subUnits: [] }
  ],
  ppeList: ["Helmet", "Safety shoes", "Gloves", "Eye protection", "Ear protection", "Face shield", "Respirator", "Full body harness", "FR coverall", "Insulating gloves"],
  jobTitles: [...DEFAULT_JOB_TITLES]
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nowISO = () => new Date().toISOString();
const uid = () => "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso); if (isNaN(d)) return "—";
  return d.toLocaleString([], { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso) { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" }); }
function initials(name) { return (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }
// Planned end of a permit (an explicit extension wins; open-ended never expires).
function permitEnd(p) { return p?.validity?.openEnded ? null : (p?.validity?.extendedTo || p?.validity?.plannedEnd || null); }
// A still-live permit whose planned end has passed is "overdue". We never change
// the stored status automatically (that would need a server write); instead the
// UI flags it so an Issuer extends or closes it.
function isOverdue(p) {
  if (!p || !["active", "extended", "awaitingIsolation"].includes(p.status)) return false;
  const end = permitEnd(p); if (!end) return false;
  const d = new Date(end); return !isNaN(d) && d.getTime() < Date.now();
}
function overdueChip() { return `<span class="badge-st st-overdue" title="Planned end has passed">Overdue</span>`; }
// Minimal RFC-4180-ish CSV line parser: handles quoted fields and embedded
// commas / doubled quotes (naive split() corrupted any description with a comma).
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/* -------------------- People & roles -------------------- */
// Job titles available in the app — config overrides the built-in default.
function jobTitles() { return (State.config?.jobTitles?.length ? State.config.jobTitles : DEFAULT_JOB_TITLES); }
// Department names from config (kept exactly as configured — never recreated here).
function departmentNames() { return (State.config?.departments || DEFAULT_CONFIG.departments).map((d) => d.name); }

// Identity meta stamped alongside a person's name on permits / certificates.
function myMeta() {
  const p = State.profile || {};
  return { jobTitle: p.jobTitle || "", department: p.department || "", employeeNumber: p.employeeNumber || "" };
}
function userMeta(u) {
  u = u || {};
  return { jobTitle: u.jobTitle || u.position || "", department: u.department || "", employeeNumber: u.employeeNumber || "" };
}
// "Full Name / Job Title / Department / Employee No." — blank parts skipped.
function personText(name, meta) {
  const parts = [name, meta?.jobTitle, meta?.department, meta?.employeeNumber]
    .map((x) => (x == null ? "" : String(x)).trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : "—";
}
// HTML-escaped variant for on-screen rendering.
function personHTML(name, meta) { return esc(personText(name, meta)); }
// <option> list helper that always keeps the current value selectable.
function optionList(items, selected) {
  const arr = [...items];
  if (selected && !arr.includes(selected)) arr.unshift(selected);
  return `<option value="">Select…</option>` + arr.map((x) => `<option ${x === selected ? "selected" : ""}>${esc(x)}</option>`).join("");
}

const TYPE_CLASS = { general: "permit-type-general", hot: "permit-type-hot", loto: "permit-type-loto", confined: "permit-type-confined" };
const TYPE_DOT = { general: "var(--steel)", hot: "var(--red)", loto: "var(--amber)", confined: "var(--green)" };

function badge(status) {
  const map = { draft: "Draft", submitted: "Submitted", awaitingIsolation: "Awaiting Isolation",
    active: "Active", extended: "Extended", closed: "Closed", rejected: "Rejected", expired: "Expired",
    isolated: "Isolated", pending: "Isolation Pending", trialRun: "Trial Run", available: "Available",
    assigned: "Assigned", removalPending: "De-isolation Pending", removed: "Removed" };
  return `<span class="badge-st st-${status}">${esc(map[status] || status)}</span>`;
}

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  newdoc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7.5 12 3 3 7.5v9L12 21l9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.5L3 11a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h5l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'
};

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast " + type; t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

let _modalKeydown = null;
function modal({ title, body, footer = "", wide = false }) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="mhead"><h3>${esc(title)}</h3><button class="x" data-close aria-label="Close">&times;</button></div>
    <div class="mbody">${body}</div>
    ${footer ? `<div class="mfoot">${footer}</div>` : ""}
  </div></div>`;
  root.querySelector("[data-close]").onclick = closeModal;
  root.querySelector(".modal-bg").onclick = (e) => { if (e.target.classList.contains("modal-bg")) closeModal(); };
  // Keyboard support: Escape closes; Tab is trapped within the dialog.
  if (_modalKeydown) document.removeEventListener("keydown", _modalKeydown);
  _modalKeydown = (e) => {
    if (e.key === "Escape") return closeModal();
    if (e.key !== "Tab") return;
    const f = $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root)
      .filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", _modalKeydown);
  // Focus the first useful field (not the close button) once painted.
  setTimeout(() => {
    const el = root.querySelector(".mbody input,.mbody select,.mbody textarea,.mfoot [data-ok],.mfoot button") || root.querySelector(".modal");
    el?.focus?.();
  }, 0);
  return root.querySelector(".modal");
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  if (_modalKeydown) { document.removeEventListener("keydown", _modalKeydown); _modalKeydown = null; }
}

function confirmBox(title, message, okLabel, onOk, danger = false) {
  modal({ title, body: `<p style="margin:.2rem 0 0;color:var(--ink-2)">${esc(message)}</p>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button>
             <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(okLabel)}</button>` });
  $("#modal-root [data-c]").onclick = closeModal;
  $("#modal-root [data-ok]").onclick = async () => { try { await onOk(); } catch (e) { toast(e.message || "Error", "err"); } };
}

/* -------------------- 3. Auth / bootstrap -------------------- */
window.addEventListener("online", () => updateOfflineBar());
window.addEventListener("offline", () => updateOfflineBar());

onAuthStateChanged(auth, async (user) => {
  State.user = user;
  // Clear any previous session's profile/role immediately. Until the new
  // user's role is confirmed from Firestore, State.profile is null so no
  // role-dependent UI (e.g. the Admin menu) can be rendered — not even for
  // a split second from a prior Admin session's stale state.
  State.profile = null;
  State.config = null;
  State.view = "dashboard";
  if (!user) return renderLogin();
  // Neutral loading screen while the role is fetched — nothing role-gated
  // is shown until the profile is fully loaded below.
  renderLoading();
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const profile = { id: user.uid, ...snap.data() };
      if (!profile.active) return renderPending();
      await loadConfig();
      // Commit the profile and render only after the role is fully loaded.
      State.profile = profile;
      renderApp();
    } else {
      // No profile yet → bootstrap or pending self-signup
      const initSnap = await getDoc(doc(db, "meta", "init"));
      if (!initSnap.exists()) return renderBootstrap(user);
      return renderCompleteProfile(user);
    }
  } catch (e) {
    renderLogin(e.message);
  }
});

async function loadConfig() {
  const c = await getDoc(doc(db, "config", "app"));
  State.config = c.exists() ? c.data() : DEFAULT_CONFIG;
}

// Neutral loading screen shown while the signed-in user's role is being
// fetched. It is intentionally free of any role-dependent UI.
function renderLoading() {
  $("#app").innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand">
      <div class="mark">${ICON.lock}</div>
      <div><div class="t1">${esc(appBranding.appName)}</div>
        <div class="t2">${esc(appBranding.company)}</div></div>
    </div>
    <div class="sub" style="display:flex;align-items:center;gap:.6rem">
      <span class="spinner" aria-hidden="true"></span>
      <span>Loading your workspace…</span>
    </div>
  </div></div>`;
}

function renderLogin(error = "") {
  let mode = "signin";
  const root = $("#app");
  const draw = () => {
    root.innerHTML = `<div class="login-wrap"><div class="login-card">
      <div class="brand">
        <div class="mark">${ICON.lock}</div>
        <div><div class="t1">${esc(appBranding.appName)}</div>
        <div class="t2">${esc(appBranding.company)}</div></div>
      </div>
      <h2>${mode === "signin" ? "Sign in" : "Create account"}</h2>
      <div class="sub">${mode === "signin" ? "Use your work email and password." : "Register — an administrator will then activate your account."}</div>
      ${error ? `<div class="err-msg">${esc(error)}</div>` : ""}
      <div id="lf"></div>
      <label class="field"><span>Email</span><input type="email" id="email" autocomplete="username" placeholder="name@nrcc.com"></label>
      <label class="field"><span>Password</span><input type="password" id="pass" autocomplete="current-password" placeholder="••••••••"></label>
      ${mode === "signin" ? `<div style="text-align:right;margin:-.55rem 0 1rem"><a href="#" id="forgot" style="font-size:.82rem">Forgot password?</a></div>` : ""}
      ${mode === "signup" ? `
        <label class="field"><span>Full name <span class="req">*</span></span><input type="text" id="fname" placeholder="e.g. Fiaz Ahmed"></label>
        <div class="grid-2">
          <label class="field"><span>Department <span class="req">*</span></span><select id="fdept">${optionList(departmentNames(), "")}</select></label>
          <label class="field"><span>Job Title <span class="req">*</span></span><select id="fjob">${optionList(jobTitles(), "")}</select></label>
        </div>
        <label class="field"><span>Employee Number <span class="req">*</span></span><input type="text" id="femp" placeholder="e.g. EMP-1042"></label>` : ""}
      <button class="btn btn-accent btn-block" id="go">${mode === "signin" ? "Sign in" : "Create account"}</button>
      <div style="text-align:center;margin-top:1rem;font-size:.85rem;color:var(--muted)">
        ${mode === "signin" ? "New here?" : "Already registered?"}
        <a href="#" id="toggle">${mode === "signin" ? "Create an account" : "Sign in"}</a>
      </div>
    </div></div>`;
    $("#toggle").onclick = (e) => { e.preventDefault(); mode = mode === "signin" ? "signup" : "signin"; error = ""; draw(); };
    $("#go").onclick = submit;
    root.querySelector("#pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    const fp = $("#forgot");
    if (fp) fp.onclick = async (e) => {
      e.preventDefault();
      const email = $("#email").value.trim();
      if (!email) return toast("Enter your email above, then click Forgot password", "err");
      try { await sendPasswordResetEmail(auth, email); toast(`Password reset link sent to ${email}`, "ok"); }
      catch (err) { toast(friendlyAuthError(err), "err"); }
    };
  };
  async function submit() {
    const email = $("#email").value.trim(), pass = $("#pass").value;
    if (!email || !pass) return toast("Enter email and password", "err");
    $("#go").disabled = true;
    try {
      if (mode === "signin") {
        await signInWithEmailAndPassword(auth, email, pass);
      } else {
        const name = $("#fname").value.trim();
        const department = $("#fdept").value, jobTitle = $("#fjob").value, employeeNumber = $("#femp").value.trim();
        if (!name) { $("#go").disabled = false; return toast("Full name is required", "err"); }
        if (!department) { $("#go").disabled = false; return toast("Select your department", "err"); }
        if (!jobTitle) { $("#go").disabled = false; return toast("Select your job title", "err"); }
        if (!employeeNumber) { $("#go").disabled = false; return toast("Employee number is required", "err"); }
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        sessionStorage.setItem("signup", JSON.stringify({ name, department, jobTitle, employeeNumber }));
        // onAuthStateChanged will route to bootstrap/complete-profile
      }
    } catch (e) {
      $("#go").disabled = false;
      renderLogin(friendlyAuthError(e));
    }
  }
  draw();
}
function friendlyAuthError(e) {
  const m = (e.code || "").replace("auth/", "");
  return ({ "invalid-credential": "Incorrect email or password.", "user-not-found": "No account with that email.",
    "wrong-password": "Incorrect password.", "email-already-in-use": "That email is already registered.",
    "weak-password": "Password must be at least 6 characters.", "invalid-email": "That email looks invalid.",
    "network-request-failed": "Network error — you appear to be offline. Sign in once while online first." }[m]) || (e.message || "Sign-in failed.");
}

function renderBootstrap(user) {
  const su = JSON.parse(sessionStorage.getItem("signup") || "{}");
  const root = $("#app");
  root.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand"><div class="mark">${ICON.lock}</div>
      <div><div class="t1">First-time setup</div><div class="t2">${esc(appBranding.company)}</div></div></div>
    <div class="info-box">You are the first user. Initialising will set up the default configuration
      (permit types, lines, areas, departments) and make <b>${esc(user.email)}</b> the <b>Administrator</b>.</div>
    <label class="field"><span>Your name <span class="req">*</span></span><input type="text" id="bn" value="${esc(su.name || "")}"></label>
    <div class="grid-2">
      <label class="field"><span>Department <span class="req">*</span></span><select id="bd">${optionList(DEFAULT_CONFIG.departments.map((d) => d.name), su.department || "")}</select></label>
      <label class="field"><span>Job Title <span class="req">*</span></span><select id="bj">${optionList(DEFAULT_JOB_TITLES, su.jobTitle || "")}</select></label>
    </div>
    <label class="field"><span>Employee Number <span class="req">*</span></span><input type="text" id="be" placeholder="e.g. EMP-1042" value="${esc(su.employeeNumber || "")}"></label>
    <button class="btn btn-accent btn-block" id="binit">Initialise system as Administrator</button>
    <div style="text-align:center;margin-top:.9rem"><a href="#" id="bso">Sign out</a></div>
  </div></div>`;
  $("#bso").onclick = (e) => { e.preventDefault(); signOut(auth); };
  $("#binit").onclick = async () => {
    const name = $("#bn").value.trim(), department = $("#bd").value, jobTitle = $("#bj").value, employeeNumber = $("#be").value.trim();
    if (!name) return toast("Enter your name", "err");
    if (!department) return toast("Select your department", "err");
    if (!jobTitle) return toast("Select your job title", "err");
    if (!employeeNumber) return toast("Enter your employee number", "err");
    $("#binit").disabled = true;
    try {
      await setDoc(doc(db, "config", "app"), DEFAULT_CONFIG);
      await setDoc(doc(db, "users", user.uid), {
        name, email: user.email, role: "admin", active: true,
        department, jobTitle, employeeNumber, createdAt: nowISO()
      });
      await setDoc(doc(db, "meta", "init"), { initialisedBy: user.uid, at: nowISO() });
      sessionStorage.removeItem("signup");
      State.profile = { id: user.uid, name, role: "admin", active: true, department, jobTitle, employeeNumber };
      await loadConfig(); renderApp(); toast("System initialised", "ok");
    } catch (e) { $("#binit").disabled = false; toast(e.message, "err"); }
  };
}

async function renderCompleteProfile(user) {
  const su = JSON.parse(sessionStorage.getItem("signup") || "{}");
  // Departments and job titles come from config/app — load it so the
  // dropdowns reflect the configured lists (never invent new departments).
  if (!State.config) { try { await loadConfig(); } catch { State.config = DEFAULT_CONFIG; } }
  // The sign-up screen already collects name, department, job title and
  // employee number — finalise the profile directly, no second form.
  if (su.name && su.department && su.jobTitle && su.employeeNumber) {
    try {
      await setDoc(doc(db, "users", user.uid), {
        name: su.name, email: user.email, role: "requester", active: false,
        department: su.department, jobTitle: su.jobTitle, employeeNumber: su.employeeNumber, createdAt: nowISO()
      });
      sessionStorage.removeItem("signup");
      return renderPending();
    } catch (e) { toast(e.message, "err"); /* fall through to the manual form */ }
  }
  const root = $("#app");
  root.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand"><div class="mark">${ICON.lock}</div>
      <div><div class="t1">Complete your profile</div><div class="t2">${esc(appBranding.company)}</div></div></div>
    <div class="info-box">Your account will be created as <b>pending</b>. An administrator must activate it and assign your role before you can raise permits.</div>
    <label class="field"><span>Your name <span class="req">*</span></span><input type="text" id="cn" value="${esc(su.name || "")}"></label>
    <div class="grid-2">
      <label class="field"><span>Department <span class="req">*</span></span><select id="cd">${optionList(departmentNames(), su.department || "")}</select></label>
      <label class="field"><span>Job Title <span class="req">*</span></span><select id="cj">${optionList(jobTitles(), su.jobTitle || "")}</select></label>
    </div>
    <label class="field"><span>Employee Number <span class="req">*</span></span><input type="text" id="ce" placeholder="e.g. EMP-1042" value="${esc(su.employeeNumber || "")}"></label>
    <button class="btn btn-accent btn-block" id="csave">Submit for approval</button>
    <div style="text-align:center;margin-top:.9rem"><a href="#" id="cso">Sign out</a></div>
  </div></div>`;
  $("#cso").onclick = (e) => { e.preventDefault(); signOut(auth); };
  $("#csave").onclick = async () => {
    const name = $("#cn").value.trim(), department = $("#cd").value, jobTitle = $("#cj").value, employeeNumber = $("#ce").value.trim();
    if (!name) return toast("Enter your name", "err");
    if (!department) return toast("Select your department", "err");
    if (!jobTitle) return toast("Select your job title", "err");
    if (!employeeNumber) return toast("Enter your employee number", "err");
    try {
      await setDoc(doc(db, "users", user.uid), {
        name, email: user.email, role: "requester", active: false,
        department, jobTitle, employeeNumber, createdAt: nowISO()
      });
      sessionStorage.removeItem("signup"); renderPending();
    } catch (e) { toast(e.message, "err"); }
  };
}

function renderPending() {
  $("#app").innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand"><div class="mark">${ICON.lock}</div>
      <div><div class="t1">Account pending</div><div class="t2">${esc(appBranding.company)}</div></div></div>
    <p style="color:var(--ink-2)">Your account is awaiting administrator approval. Please check back later.</p>
    <button class="btn btn-ghost btn-block" id="pso">Sign out</button></div></div>`;
  $("#pso").onclick = () => signOut(auth);
}

/* -------------------- 4. App shell & router -------------------- */
// True only when a profile with a confirmed Admin role is loaded.
// Used to gate every Admin-only menu item and view.
function isAdmin() { return State.profile?.role === "admin"; }

function navItems() {
  // Guard: never build navigation before the role is confirmed.
  if (!State.profile) return [];
  const items = [
    { v: "dashboard", label: "Dashboard", icon: ICON.home },
    { v: "new", label: "New Permit", icon: ICON.newdoc },
    { v: "permits", label: "Permit Register", icon: ICON.list },
    { v: "equipment", label: "Equipment", icon: ICON.cube }
  ];
  if (isAdmin()) items.push({ v: "admin", label: "Administration", icon: ICON.gear });
  return items;
}

function renderApp() {
  const p = State.profile;
  $("#app").innerHTML = `
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="logo"><div class="mark">${ICON.lock}</div>
          <div><b>NRCC PTW</b><small>Permit to Work</small></div></div>
        <nav id="nav"></nav>
        <div class="foot">${esc(appBranding.company)} · ${esc(appBranding.site)}<br>v1.0</div>
      </aside>
      <header class="topbar">
        <h1 id="topTitle">Dashboard</h1>
        <div class="spacer"></div>
        <div class="who">
          <div style="text-align:right"><div style="font-weight:700">${esc(p.name)}</div>
            <span class="role-chip">${esc(p.role)}</span></div>
          <div class="avatar">${initials(p.name)}</div>
          <button class="btn btn-ghost btn-sm" id="logout" title="Sign out" aria-label="Sign out">${ICON.out}</button>
        </div>
      </header>
      <main class="main" id="main"></main>
      <nav class="bottomnav" id="bnav"></nav>
    </div>`;
  const shortLabels = { dashboard: "Home", new: "New", permits: "Register", equipment: "Equipment", admin: "Admin" };
  const nav = $("#nav"), bnav = $("#bnav");
  navItems().forEach((it) => {
    const b = document.createElement("button");
    b.className = "navitem"; b.dataset.v = it.v;
    b.innerHTML = `${it.icon}<span>${it.label}</span><span class="badge hidden" data-badge></span>`;
    b.onclick = () => go(it.v);
    nav.appendChild(b);
    const m = document.createElement("button");
    m.className = "bn-item"; m.dataset.v = it.v;
    m.innerHTML = `${it.icon}<span>${shortLabels[it.v] || it.label}</span>`;
    m.onclick = () => go(it.v);
    bnav.appendChild(m);
  });
  $("#logout").onclick = () => signOut(auth);
  updateOfflineBar();
  go(State.view || "dashboard");
  refreshPendingBadge();
}

function go(view, params = {}) {
  // Hard guard: the Administration view is Admin-only. Even if navigation is
  // triggered some other way, a non-Admin can never render Admin controls.
  if (view === "admin" && !isAdmin()) view = "dashboard";
  State.view = view; State.params = params;
  const hv = ["isolations", "isodetail", "detail"].includes(view) ? "permits" : view;
  $$(".navitem,.bn-item").forEach((n) => n.classList.toggle("active", n.dataset.v === hv));
  const titles = { dashboard: "Dashboard", new: "New Permit", permits: "Permit Register", isolations: "Isolation Certificates", isodetail: "Isolation Certificate", equipment: "Equipment", admin: "Administration", detail: "Permit Detail" };
  $("#topTitle").textContent = titles[view] || "";
  const m = $("#main"); m.scrollTop = 0;
  ({ dashboard: viewDashboard, new: viewNewPermit, permits: viewPermits, isolations: viewIsolations, isodetail: viewIsolationDetail, equipment: viewEquipment, admin: viewAdmin, detail: viewPermitDetail }[view] || viewDashboard)(m);
}

function updateOfflineBar() {
  const main = $("#main"); if (!main) return;
  let bar = $("#offbar");
  if (!navigator.onLine) {
    if (!bar) { bar = document.createElement("div"); bar.id = "offbar"; bar.className = "offline-bar";
      bar.textContent = "Offline — changes are saved on this device and will sync when you reconnect.";
      main.prepend(bar); }
  } else { bar?.remove(); }
}

/* data fetch helpers */
async function fetchAll(coll) {
  const snap = await getDocs(collection(db, coll));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function fetchPermits() { const a = await fetchAll("permits"); a.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || "")); return a; }
async function fetchEquipment() { const a = await fetchAll("equipment"); a.sort((x, y) => (x.tag || "").localeCompare(y.tag || "")); return a; }
async function fetchIsolations() { const a = await fetchAll("isolations"); a.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || "")); return a; }
async function activeUsers() { const u = await fetchAll("users"); return u.filter((x) => x.active).sort((a, b) => (a.name || "").localeCompare(b.name || "")); }
// Only active users holding the Isolator role — used for isolation / de-isolation assignment.
async function isolatorUsers() { return (await activeUsers()).filter((x) => x.role === "isolator"); }

// A confirmed (active) certificate is ready for de-isolation once every permit
// attached to it has had its work confirmed complete (or is otherwise closed).
// This is what makes the Isolator's de-isolation step open automatically after
// the last crew signs off — without the requester writing to the certificate.
function isoReadyForDeiso(iso, permits) {
  if (!iso || iso.status !== "active") return false;
  const att = permits.filter((p) => p.isolationRef === iso.id);
  if (!att.length) return false;
  return att.every((p) =>
    ["closed", "rejected", "expired"].includes(p.status) ||
    (["active", "extended"].includes(p.status) && !!p.workCompletion));
}

async function refreshPendingBadge() {
  if (!["issuer", "admin"].includes(State.profile.role)) return;
  try {
    const permits = await fetchPermits();
    const pending = permits.filter((p) => p.status === "submitted").length;
    const b = $('.navitem[data-v="dashboard"] [data-badge]');
    if (b) { b.classList.toggle("hidden", pending === 0); b.textContent = pending; }
  } catch {}
}

/* -------------------- 5a. Dashboard -------------------- */
async function viewDashboard(m) {
  m.innerHTML = `<div class="page-head"><div><div class="kick">Overview</div><h2>Welcome, ${esc(State.profile.name.split(" ")[0])}</h2></div>
    <div class="actions"><button class="btn btn-accent">+ New Permit</button></div></div>
    <div id="dash">Loading…</div>`;
  m.querySelector(".actions .btn").onclick = () => go("new");
  const permits = await fetchPermits();
  const equip = await fetchEquipment();
  const isoAll = await fetchIsolations();
  const mine = permits.filter((p) => p.requester?.uid === State.profile.id);
  const active = permits.filter((p) => ["active", "extended"].includes(p.status));
  const pending = permits.filter((p) => p.status === "submitted");
  const isolated = equip.filter((e) => e.isolationStatus === "isolated" || e.isolationStatus === "trialRun");
  const isIssuer = ["issuer", "admin"].includes(State.profile.role);
  const overdue = (isIssuer ? permits : mine).filter(isOverdue);

  const stat = (num, lab, ic) => `<div class="stat"><div class="ic">${ic}</div><div class="num">${num}</div><div class="lab">${lab}</div></div>`;
  let html = `<div class="cols cols-4" style="margin-bottom:1.2rem">
    ${stat(active.length, "Active permits", ICON.list)}
    ${stat(pending.length, isIssuer ? "Awaiting your approval" : "Submitted", ICON.newdoc)}
    ${stat(isolated.length, "Equipment isolated", ICON.lock)}
    ${stat(mine.length, "My permits", ICON.cube)}</div>`;
  if (overdue.length) html += `<div class="danger-box" id="overdueBanner" style="cursor:pointer"><b>${overdue.length} permit(s) overdue</b> — the planned end has passed. Review and extend or close them.</div>`;

  const me = State.profile.id;
  const isAdmin = State.profile.role === "admin";
  // Any Isolator sees all open isolation / de-isolation tasks (not just ones
  // assigned to them by name) so whoever is on shift can action them. A cert
  // becomes a de-isolation task automatically once all its crews report done.
  // De-isolation is a physical lockout job, so it is an Isolator task only —
  // the Issuer does NOT de-isolate (Admin is kept as a system superuser).
  const isIso = State.profile.role === "isolator";
  const tasks = isoAll.filter((i) =>
    (i.status === "assigned" && (isIssuer || isIso || i.assignedTo?.uid === me)) ||
    (i.status === "removalPending" && (isIso || isAdmin || i.removalAssignedTo?.uid === me)) ||
    (isoReadyForDeiso(i, permits) && (isIso || isAdmin)));
  if (tasks.length) {
    html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Isolation tasks</h3></div>
      <table class="tbl"><thead><tr><th>Certificate</th><th>Equipment</th><th>Status</th><th>Assigned to</th></tr></thead><tbody>
      ${tasks.map((i) => { const deiso = i.status === "removalPending" || isoReadyForDeiso(i, permits); return `<tr class="row" data-iid="${i.id}">
        <td><span class="mono">${esc(i.isoNo || i.id)}</span></td><td>${esc(i.equipmentTag)}</td>
        <td>${badge(deiso ? "removalPending" : i.status)}</td><td>${esc((deiso ? i.removalAssignedTo?.name : i.assignedTo?.name) || "—")}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  }

  if (isIssuer && pending.length) {
    html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Awaiting approval</h3></div>
      <table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Requester</th><th></th></tr></thead><tbody>
      ${pending.map((p) => permitRow(p)).join("")}</tbody></table></div>`;
  }
  html += `<div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>${isIssuer ? "Active work" : "My recent permits"}</h3></div>
    <table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Status</th><th>Requester</th></tr></thead><tbody>
    ${(isIssuer ? active : mine).slice(0, 8).map((p) => permitRow(p, true)).join("") || `<tr><td colspan="5" class="empty">Nothing yet — raise a permit to get started.</td></tr>`}
    </tbody></table></div>`;
  $("#dash").innerHTML = html;
  bindPermitRows();
  const ob = $("#overdueBanner"); if (ob) ob.onclick = () => go("permits", { status: "overdue" });
  $$("tr.row[data-iid]").forEach((r) => r.onclick = () => go("isodetail", { id: r.dataset.iid }));
}

function permitRow(p, showStatus = false) {
  return `<tr class="row" data-pid="${p.id}">
    <td><span class="mono">${esc(p.permitNo)}</span></td>
    <td><span class="type-pill"><span class="dot" style="background:${TYPE_DOT[p.type]}"></span>${esc(p.typeName || p.type)}</span></td>
    <td>${esc(p.equipmentTag || "—")}</td>
    ${showStatus ? `<td>${badge(p.status)}${isOverdue(p) ? " " + overdueChip() : ""}</td>` : ""}
    <td>${esc(p.requester?.name || "—")}</td>
    ${!showStatus ? `<td></td>` : ""}
  </tr>`;
}
function bindPermitRows() { $$("tr.row[data-pid]").forEach((r) => r.onclick = () => go("detail", { id: r.dataset.pid })); }

/* -------------------- 5b. Permit Register -------------------- */
async function viewPermits(m) {
  let lastRows = [];
  m.innerHTML = `<div class="page-head"><div><div class="kick">Records</div><h2>Permit Register</h2></div>
    <div class="actions"><button class="btn btn-ghost" id="expCsv">Export CSV</button><button class="btn btn-accent" id="np">+ New Permit</button></div></div>
    ${tabsHtml("p")}
    <div class="filters">
      <input class="search" id="q" placeholder="Search permit no, equipment, work…">
      <select id="fType"><option value="">All types</option></select>
      <select id="fStatus"><option value="">All statuses</option>
        ${["draft", "submitted", "awaitingIsolation", "active", "extended", "closed", "rejected"].map((s) => `<option>${s}</option>`).join("")}
        <option value="overdue">overdue</option></select>
      <select id="fDept"><option value="">All departments</option></select>
    </div>
    <div class="card pad0" id="ptable">Loading…</div>`;
  $("#np").onclick = () => go("new");
  $("#expCsv").onclick = () => exportPermitsCsv(lastRows);
  bindTabs();
  $("#fType").innerHTML += State.config.permitTypes.map((t) => `<option value="${t.code}">${esc(t.name)}</option>`).join("");
  $("#fDept").innerHTML += State.config.departments.map((d) => `<option>${esc(d.name)}</option>`).join("");
  if (State.params.status) $("#fStatus").value = State.params.status;
  const all = await fetchPermits();
  const draw = () => {
    const q = $("#q").value.toLowerCase(), ft = $("#fType").value, fs = $("#fStatus").value, fd = $("#fDept").value;
    const rows = all.filter((p) =>
      (!ft || p.type === ft) &&
      (!fs || (fs === "overdue" ? isOverdue(p) : p.status === fs)) &&
      (!fd || p.requestingDepartment?.department === fd) &&
      (!q || [p.permitNo, p.equipmentTag, p.workDescription, p.requester?.name].join(" ").toLowerCase().includes(q)));
    lastRows = rows;
    $("#ptable").innerHTML = `<table class="tbl"><thead><tr><th>Permit</th><th>Type</th><th>Equipment</th><th>Dept</th><th>Status</th><th>Requester</th><th>Created</th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="row" data-pid="${p.id}">
        <td><span class="mono">${esc(p.permitNo)}</span></td>
        <td><span class="type-pill"><span class="dot" style="background:${TYPE_DOT[p.type]}"></span>${esc(p.typeName)}</span></td>
        <td>${esc(p.equipmentTag)}</td><td>${esc(p.requestingDepartment?.department || "—")}</td>
        <td>${badge(p.status)}${isOverdue(p) ? " " + overdueChip() : ""}</td><td>${esc(p.requester?.name)}</td><td>${fmtDate(p.createdAt)}</td></tr>`).join("")
      || `<tr><td colspan="7" class="empty">No permits match.</td></tr>`}</tbody></table>`;
    bindPermitRows();
  };
  ["q", "fType", "fStatus", "fDept"].forEach((id) => $("#" + id).addEventListener("input", draw));
  draw();
}

// Download the currently-filtered permit register as a CSV file (client-side).
function exportPermitsCsv(rows) {
  if (!rows || !rows.length) return toast("Nothing to export for the current filter", "err");
  const cols = [
    ["Permit No", (p) => p.permitNo],
    ["Type", (p) => p.typeName || p.type],
    ["Status", (p) => isOverdue(p) ? p.status + " (overdue)" : p.status],
    ["Equipment", (p) => p.equipmentTag],
    ["Line", (p) => p.line], ["Area", (p) => p.area],
    ["Department", (p) => p.requestingDepartment?.department || ""],
    ["Requester", (p) => p.requester?.name || ""],
    ["Work", (p) => p.workDescription || ""],
    ["Valid from", (p) => p.validity?.start || ""],
    ["Valid to", (p) => p.validity?.openEnded ? "Open" : (p.validity?.extendedTo || p.validity?.plannedEnd || "")],
    ["Isolation cert", (p) => p.isoNo || ""],
    ["Created", (p) => p.createdAt || ""]
  ];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => cell(c[0])).join(",")]
    .concat(rows.map((p) => cols.map((c) => cell(c[1](p))).join(",")))
    .join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `permits-${nowISO().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} permit(s)`, "ok");
}

/* -------------------- 5c. New Permit -------------------- */
async function viewNewPermit(m) {
  if (!State.profile.active) { m.innerHTML = `<div class="danger-box">Your account is not active yet.</div>`; return; }
  const cfg = State.config;
  const equip = await fetchEquipment();
  // Editing an existing draft? Load it (owner-only, drafts only) and prefill the
  // form below. Anything else falls through to a blank "new permit".
  const editId = State.params.editId || null;
  let editing = null;
  if (editId) {
    const s = await getDoc(doc(db, "permits", editId)).catch(() => null);
    if (!s || !s.exists()) return go("permits");
    editing = { id: editId, ...s.data() };
    if (editing.status !== "draft" || editing.requester?.uid !== State.profile.id) return go("detail", { id: editId });
  }
  let type = editing ? (cfg.permitTypes.find((t) => t.code === editing.type) || cfg.permitTypes[0]) : cfg.permitTypes[0];
  let prefilled = false;
  const draw = () => {
    const deptOpts = cfg.departments.map((d) => `<option>${esc(d.name)}</option>`).join("");
    m.innerHTML = `<div class="page-head"><div><div class="kick">${editing ? "Edit" : "Create"}</div><h2>${editing ? "Edit Draft Permit" : "New Work Permit"}</h2></div></div>
    <div class="card ${TYPE_CLASS[type.code]}">
      <h3>Permit type</h3><div class="csub">Choose the kind of work — the form adapts to it.</div>
      <div class="cols cols-4">${cfg.permitTypes.map((t) => `
        <button class="navitem ${t.code === type.code ? "active" : ""}" data-type="${t.code}" style="border:1px solid var(--line);justify-content:center;text-align:center">
          <span class="dot" style="background:${TYPE_DOT[t.code]}"></span>${esc(t.name)}</button>`).join("")}</div>
    </div>

    <div class="card">
      <h3>Equipment</h3><div class="csub">Search by tag or name. ${type.requiresIsolation ? "This permit requires isolation." : ""}</div>
      <label class="field"><span>Equipment <span class="req">*</span></span>
        <input type="text" id="eqSearch" placeholder="Type tag e.g. 362FN1 or a name…" autocomplete="off">
        <div id="eqResults"></div>
        <input type="hidden" id="eqId"><div id="eqChosen"></div>
      </label>
      <div id="simops"></div>
    </div>

    <div class="card">
      <h3>Work details</h3>
      <div class="grid-2">
        <label class="field"><span>Requesting department <span class="req">*</span></span>
          <select id="dept">${deptOpts}</select></label>
        <label class="field"><span>Sub-unit</span><select id="subunit"></select></label>
      </div>
      <label class="field"><span>Work description <span class="req">*</span></span>
        <textarea id="desc" placeholder="Describe the work to be carried out…"></textarea></label>
      <label class="field"><span>Specific location / note</span><input type="text" id="loc" placeholder="e.g. motor NDE bearing"></label>
      <div class="grid-2">
        <label class="field"><span>Valid from <span class="req">*</span></span><input type="datetime-local" id="vstart"></label>
        <label class="field"><span>Planned end</span><input type="datetime-local" id="vend">
          <span class="help"><label class="checkline" style="padding:.3rem 0"><input type="checkbox" id="vopen"> Open-ended (valid while active)</label></span></label>
      </div>
    </div>

    <div class="card">
      <h3>Hazard checklist — ${esc(type.name)}</h3>
      <div id="checks">${type.checklist.map((c, i) => `<label class="checkline"><input type="checkbox" data-chk="${i}"> ${esc(c)}</label>`).join("")}</div>
    </div>

    <div class="card">
      <h3>PPE required</h3>
      <div class="cols cols-3">${cfg.ppeList.map((p) => `<label class="checkline"><input type="checkbox" data-ppe value="${esc(p)}"> ${esc(p)}</label>`).join("")}</div>
    </div>

    ${type.requiresIsolation ? `<div class="card">
      <h3>Isolation / LOTO register</h3><div class="csub">List the isolation points to be applied.</div>
      <div id="isoRows"></div>
      <button class="btn btn-ghost btn-sm" id="addIso">+ Add isolation point</button></div>` : ""}

    ${type.requiresGasTest ? `<div class="card">
      <h3>Gas test</h3><div class="csub">Record readings where applicable.</div>
      <div class="grid-3">
        <label class="field"><span>O₂ (%)</span><input type="number" step="0.1" id="g_o2" placeholder="20.9"></label>
        <label class="field"><span>LEL (%)</span><input type="number" step="0.1" id="g_lel" placeholder="0"></label>
        <label class="field"><span>H₂S (ppm)</span><input type="number" step="1" id="g_h2s" placeholder="0"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>CO (ppm)</span><input type="number" step="1" id="g_co" placeholder="0"></label>
        <label class="field"><span>Tested by</span><input type="text" id="g_by" placeholder="Name"></label>
      </div></div>` : ""}

    <div class="card" style="display:flex;gap:.7rem;justify-content:flex-end">
      <button class="btn btn-ghost" id="saveDraft">Save as draft</button>
      <button class="btn btn-accent" id="submit">Submit for approval</button>
    </div>`;

    // type buttons
    $$("[data-type]").forEach((b) => b.onclick = () => { type = cfg.permitTypes.find((t) => t.code === b.dataset.type); draw(); });
    // default validity start = now
    const n = new Date(); n.setMinutes(n.getMinutes() - n.getTimezoneOffset());
    $("#vstart").value = n.toISOString().slice(0, 16);
    // Open-ended permits have no planned end — disable the end field accordingly.
    const vopenEl = $("#vopen"), vendEl = $("#vend");
    const syncOpen = () => { vendEl.disabled = vopenEl.checked; if (vopenEl.checked) vendEl.value = ""; };
    vopenEl.onchange = syncOpen; syncOpen();
    // dept → subunit
    const fillSub = () => { const d = cfg.departments.find((x) => x.name === $("#dept").value);
      $("#subunit").innerHTML = `<option value="">—</option>` + (d?.subUnits || []).map((s) => `<option>${esc(s)}</option>`).join(""); };
    $("#dept").onchange = fillSub; fillSub();
    // equipment search
    const eqSearch = $("#eqSearch"), eqResults = $("#eqResults");
    eqSearch.addEventListener("input", () => {
      const q = eqSearch.value.toLowerCase().trim();
      if (!q) { eqResults.innerHTML = ""; return; }
      const hits = equip.filter((e) => (e.tag + " " + e.description).toLowerCase().includes(q)).slice(0, 6);
      eqResults.innerHTML = hits.length
        ? `<div class="card pad0" style="margin:.4rem 0 0">${hits.map((e) => `<div class="navitem" data-eq="${e.id}"><span class="mono">${esc(e.tag)}</span>&nbsp;<span style="color:var(--muted)">${esc(e.description || "")}</span>${e.isolationStatus !== "available" ? badge(e.isolationStatus) : ""}</div>`).join("")}</div>`
        : `<div class="help">No match. ${["issuer", "admin"].includes(State.profile.role) ? '<a href="#" id="quickAdd">Add new equipment</a>' : "Ask an Issuer/Admin to add this equipment."}</div>`;
      $$("[data-eq]").forEach((d) => d.onclick = () => chooseEq(equip.find((e) => e.id === d.dataset.eq)));
      const qa = $("#quickAdd"); if (qa) qa.onclick = (e) => { e.preventDefault(); openAddEquipment(equip, (added) => { equip.push(added); chooseEq(added); }); };
    });
    function chooseEq(e) {
      $("#eqId").value = e.id; eqSearch.value = ""; eqResults.innerHTML = "";
      $("#eqChosen").innerHTML = `<div class="attached-list" style="margin-top:.5rem"><div class="a">
        ${ICON.cube}<b class="mono">${esc(e.tag)}</b> ${esc(e.description || "")} · ${esc(e.line)} / ${esc(e.area)}
        ${e.isolationStatus !== "available" ? badge(e.isolationStatus) : ""}
        <button class="btn btn-ghost btn-sm" id="clearEq" style="margin-left:auto">Change</button></div></div>`;
      $("#clearEq").onclick = () => { $("#eqId").value = ""; $("#eqChosen").innerHTML = ""; $("#simops").innerHTML = ""; };
      showSimops(e);
    }
    async function showSimops(e) {
      const permits = await fetchPermits();
      const activeOnEq = permits.filter((p) => p.equipmentRef === e.id && ["submitted", "active", "extended"].includes(p.status));
      if (activeOnEq.length) {
        $("#simops").innerHTML = `<div class="warn-box"><b>${activeOnEq.length} active permit(s) already on ${esc(e.tag)}.</b>
          The Issuer will review concurrent work. ${e.isolationStatus === "isolated" ? "This equipment is already isolated; an isolation permit will attach to the existing isolation." : ""}
          <div class="attached-list" style="margin-top:.5rem">${activeOnEq.map((p) => `<div class="a"><span class="mono">${esc(p.permitNo)}</span> ${esc(p.typeName)} · ${esc(p.requester?.name)} ${badge(p.status)}</div>`).join("")}</div></div>`;
      } else $("#simops").innerHTML = "";
    }
    // isolation rows
    if (type.requiresIsolation) {
      const addRow = () => { const d = document.createElement("div"); d.className = "iso-row";
        d.innerHTML = `<input placeholder="Isolation point (e.g. MCC-3 breaker)"><input placeholder="Method (rack-out / valve)"><input placeholder="Lock / tag no.">
          <button class="btn btn-ghost btn-sm">✕</button>`;
        d.querySelector("button").onclick = () => d.remove(); $("#isoRows").appendChild(d); };
      $("#addIso").onclick = addRow; addRow();
    }
    $("#saveDraft").onclick = () => savePermit("draft");
    $("#submit").onclick = () => savePermit("submitted");

    // Prefill from the draft being edited — only on the first render. A manual
    // permit-type change after that intentionally resets the type-specific fields.
    if (editing && !prefilled) {
      prefilled = true;
      if (editing.requestingDepartment?.department) $("#dept").value = editing.requestingDepartment.department;
      fillSub();
      if (editing.requestingDepartment?.subUnit) $("#subunit").value = editing.requestingDepartment.subUnit;
      $("#desc").value = editing.workDescription || "";
      $("#loc").value = editing.location || "";
      if (editing.validity?.start) $("#vstart").value = String(editing.validity.start).slice(0, 16);
      if (editing.validity?.openEnded) { $("#vopen").checked = true; syncOpen(); }
      else if (editing.validity?.plannedEnd) $("#vend").value = String(editing.validity.plannedEnd).slice(0, 16);
      (editing.checklist || []).forEach((c, i) => { const el = $(`[data-chk="${i}"]`); if (el) el.checked = !!c.checked; });
      const ppeSet = new Set(editing.ppe || []);
      $$("[data-ppe]").forEach((el) => { el.checked = ppeSet.has(el.value); });
      if (type.requiresIsolation && (editing.isolationPoints || []).length) {
        $("#isoRows").innerHTML = "";
        editing.isolationPoints.forEach((pt) => {
          const d = document.createElement("div"); d.className = "iso-row";
          d.innerHTML = `<input placeholder="Isolation point (e.g. MCC-3 breaker)"><input placeholder="Method (rack-out / valve)"><input placeholder="Lock / tag no."><button class="btn btn-ghost btn-sm">✕</button>`;
          const ins = d.querySelectorAll("input");
          ins[0].value = pt.point || ""; ins[1].value = pt.method || ""; ins[2].value = pt.lockTag || "";
          d.querySelector("button").onclick = () => d.remove();
          $("#isoRows").appendChild(d);
        });
      }
      if (type.requiresGasTest && editing.gasTest) {
        const g = editing.gasTest;
        if ($("#g_o2")) $("#g_o2").value = g.o2 || "";
        if ($("#g_lel")) $("#g_lel").value = g.lel || "";
        if ($("#g_h2s")) $("#g_h2s").value = g.h2s || "";
        if ($("#g_co")) $("#g_co").value = g.co || "";
        if ($("#g_by")) $("#g_by").value = g.by || "";
      }
      const eqExisting = equip.find((x) => x.id === editing.equipmentRef);
      if (eqExisting) chooseEq(eqExisting);
    }
  };

  async function savePermit(status) {
    const eqId = $("#eqId").value;
    if (!eqId) return toast("Select the equipment", "err");
    const desc = $("#desc").value.trim();
    if (!desc) return toast("Enter the work description", "err");
    const e = equip.find((x) => x.id === eqId);
    const checklist = type.checklist.map((c, i) => ({ item: c, checked: !!$(`[data-chk="${i}"]`)?.checked }));
    const ppe = $$("[data-ppe]:checked").map((x) => x.value);
    let isolationPoints = [];
    if (type.requiresIsolation) isolationPoints = $$("#isoRows .iso-row").map((r) => {
      const [pt, mt, lk] = [...r.querySelectorAll("input")].map((i) => i.value.trim());
      return { point: pt, method: mt, lockTag: lk };
    }).filter((x) => x.point);
    let gasTest = null;
    if (type.requiresGasTest) gasTest = { required: true, o2: $("#g_o2").value, lel: $("#g_lel").value, h2s: $("#g_h2s").value, co: $("#g_co").value, by: $("#g_by").value.trim(), time: nowISO() };
    const open = $("#vopen").checked;
    // Validation. The date range is checked on any save; the full hazard / gas
    // checks only when submitting for approval (drafts may be saved incomplete).
    const startV = $("#vstart").value || "", endV = $("#vend").value || "";
    if (!open && endV && startV && new Date(endV) <= new Date(startV)) return toast("Planned end must be after the valid-from time.", "err");
    if (status === "submitted") {
      if (!checklist.every((c) => c.checked)) return toast("Tick every hazard-checklist item before submitting (or use Save as draft).", "err");
      if (type.requiresGasTest && (!gasTest || !String(gasTest.o2).trim() || !String(gasTest.lel).trim() || !gasTest.by))
        return toast("Enter the gas-test readings (O₂, LEL) and who tested before submitting.", "err");
    }
    const requestingDepartment = { department: $("#dept").value, subUnit: $("#subunit").value || null };
    const validity = { start: $("#vstart").value || nowISO(), openEnded: open, plannedEnd: open ? null : ($("#vend").value || null), extendedTo: editing?.validity?.extendedTo ?? null };
    try {
      if (editing) {
        // Update the existing draft in place. Identity / audit fields (permitNo,
        // requester, approval, createdAt…) are deliberately left untouched so the
        // write satisfies the security rules and the audit trail stays intact.
        await updateDoc(doc(db, "permits", editing.id), {
          type: type.code, typeName: type.name, status,
          equipmentRef: eqId, equipmentTag: e.tag, line: e.line, area: e.area,
          requestingDepartment, workDescription: desc, location: $("#loc").value.trim(),
          validity, checklist, ppe, gasTest, isolationPoints, updatedAt: nowISO()
        });
        toast(status === "draft" ? "Draft updated" : "Permit submitted for approval", "ok");
        return go("detail", { id: editing.id });
      }
      const permit = {
        permitNo: makePermitNo(type),
        type: type.code, typeName: type.name,
        status,
        equipmentRef: eqId, equipmentTag: e.tag, line: e.line, area: e.area,
        isolationRef: null, isoNo: null,
        requester: { uid: State.profile.id, name: State.profile.name, ...myMeta() },
        requestingDepartment,
        workDescription: desc, location: $("#loc").value.trim(),
        validity,
        checklist, ppe, gasTest, isolationPoints,
        approval: null, rejection: null, closure: null, trialRuns: [],
        sync: { createdOffline: !navigator.onLine },
        createdAt: nowISO(), updatedAt: nowISO()
      };
      const ref = await addDoc(collection(db, "permits"), permit);
      toast(status === "draft" ? "Draft saved" : "Permit submitted for approval", "ok");
      go("detail", { id: ref.id });
    } catch (err) { toast(err.message, "err"); }
  }
  draw();
}
function makePermitNo(type) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `NRCC-${type.abbr}-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/* -------------------- 5d. Permit Detail -------------------- */
async function viewPermitDetail(m) {
  m.innerHTML = `<div id="pd">Loading…</div>`;
  const id = State.params.id;
  const snap = await getDoc(doc(db, "permits", id));
  if (!snap.exists()) { $("#pd").innerHTML = `<div class="danger-box">Permit not found.</div>`; return; }
  const p = { id, ...snap.data() };
  const isIssuer = ["issuer", "admin"].includes(State.profile.role);
  const isOwner = p.requester?.uid === State.profile.id;
  // De-isolation is the Isolator's job; Admin kept only as a superuser fallback.
  const isIsoOrAdmin = ["isolator", "admin"].includes(State.profile.role);
  const eqSnap = await getDoc(doc(db, "equipment", p.equipmentRef)).catch(() => null);
  const equip = eqSnap && eqSnap.exists() ? { id: eqSnap.id, ...eqSnap.data() } : null;
  const isoSnap = p.isolationRef ? await getDoc(doc(db, "isolations", p.isolationRef)).catch(() => null) : null;
  const isoDoc = isoSnap && isoSnap.exists() ? { id: isoSnap.id, ...isoSnap.data() } : null;
  // Equipment temporarily energised for a trial run — surface a persistent
  // "Re-isolate now" action (the post-trial prompt is easy to dismiss or miss).
  const inTrial = (equip && equip.isolationStatus === "trialRun") || (isoDoc && isoDoc.status === "trialRun");

  // Hand-back order: requester confirms work complete → Isolator de-isolates →
  // Issuer closes. The equipment is de-isolated when there is no certificate or
  // its certificate has been removed.
  const deisolated = !p.isolationRef || (isoDoc && isoDoc.status === "removed");
  const awaitingDeiso = ["active", "extended"].includes(p.status) && p.workCompletion && !deisolated;
  // For a shared certificate, de-isolation only opens once every crew has signed
  // off. Work that out so we can show whether it's ready now or waiting on others.
  let deisoReady = false;
  if (awaitingDeiso && isoDoc) {
    const allPermits = await fetchPermits();
    deisoReady = isoDoc.status === "removalPending" || isoReadyForDeiso(isoDoc, allPermits);
  }
  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  let actions = "";
  if (p.status === "submitted" && isIssuer) actions += `<button class="btn btn-success" id="approve">Approve</button>`;
  if (["submitted", "awaitingIsolation"].includes(p.status) && isIssuer) actions += `<button class="btn btn-danger" id="reject">Reject</button>`;
  if (["draft"].includes(p.status) && isOwner) actions += `<button class="btn btn-ghost" id="editDraft">Edit</button><button class="btn btn-accent" id="submitNow">Submit for approval</button>`;
  // The requester signs off that the work is finished and the equipment is safe
  // to return to service. The Issuer can only close after de-isolation.
  if (["active", "extended"].includes(p.status) && isOwner && !p.workCompletion) actions += `<button class="btn btn-success" id="workdone">Confirm work complete</button>`;
  if (awaitingDeiso && deisoReady && isIsoOrAdmin) actions += `<button class="btn btn-accent" id="godeiso">Go to de-isolation</button>`;
  if (["active", "extended"].includes(p.status) && isIssuer) {
    actions += `<button class="btn btn-ghost" id="extend">Extend</button>`;
    if (p.workCompletion && deisolated) actions += `<button class="btn btn-primary" id="close">Close permit</button>`;
  }
  if (["active", "extended"].includes(p.status) && isIssuer && p.isolationRef && !inTrial) actions += `<button class="btn btn-danger" id="trial">Start trial run</button>`;
  if (["active", "extended"].includes(p.status) && isIssuer && p.isolationRef && inTrial) actions += `<button class="btn btn-success" id="reiso">Re-isolate now</button>`;
  actions += `<button class="btn btn-ghost no-print" id="pdf">${ICON.pdf} Print / PDF</button>`;

  $("#pd").innerHTML = `
    <div class="page-head"><div><div class="kick">Permit · ${esc(p.typeName)}</div>
      <h2 style="display:flex;align-items:center;gap:.6rem"><span class="mono" style="font-size:1.1rem">${esc(p.permitNo)}</span> ${badge(p.status)}</h2></div>
      <div class="actions">${actions}</div></div>

    ${p.rejection ? `<div class="danger-box"><b>Rejected.</b> ${esc(p.rejection.reason || "")} <span style="color:var(--muted)">— ${personHTML(p.rejection.byName, p.rejection)}, ${fmt(p.rejection.timestamp)}</span></div>` : ""}
    ${isOverdue(p) ? `<div class="danger-box"><b>Permit overdue.</b> The planned end (${fmt(permitEnd(p))}) has passed. ${isIssuer ? "Extend the validity or close the permit." : "Ask the Issuer to extend or close this permit."}</div>` : ""}
    ${equip && equip.isolationStatus === "trialRun" ? `<div class="danger-box"><b>⚠ TRIAL RUN IN PROGRESS — equipment ${esc(equip.tag)} is ENERGISED.</b></div>` : ""}
    ${p.status === "awaitingIsolation" ? `<div class="warn-box"><b>Awaiting isolation.</b> Certificate <span class="mono">${esc(p.isoNo || "")}</span> is assigned to <b>${personHTML(isoDoc?.assignedTo?.name, isoDoc?.assignedTo)}</b> — the permit activates automatically when the isolation is confirmed.</div>` : ""}
    ${["active", "extended"].includes(p.status) && !p.workCompletion ? `<div class="warn-box"><b>Awaiting work-completion confirmation.</b> ${isOwner ? "When the job is finished, tap <b>Confirm work complete</b> to confirm the equipment is safe to return to service." : "The requester must confirm the work is complete and the equipment is safe before the permit can be closed."}</div>` : ""}
    ${awaitingDeiso ? `<div class="warn-box"><b>Work complete — awaiting de-isolation.</b> Confirmed by ${personHTML(p.workCompletion.name, p.workCompletion)} · ${fmt(p.workCompletion.timestamp)}.${p.workCompletion.remarks ? " " + esc(p.workCompletion.remarks) : ""} <b>Locks are still on.</b> ${deisoReady ? `An Isolator must de-isolate <span class="mono">${esc(p.equipmentTag || "")}</span> on certificate <a href="#" data-isolink3 class="mono">${esc(p.isoNo || p.isolationRef)}</a> before this permit can be closed.` : `Other crews on the shared isolation are still working — de-isolation will open once every crew has confirmed work complete.`}</div>` : ""}
    ${["active", "extended"].includes(p.status) && p.workCompletion && deisolated ? `<div class="ok-box"><b>Work complete${p.isolationRef ? " and equipment de-isolated" : ""} — confirmed by ${personHTML(p.workCompletion.name, p.workCompletion)}</b> · ${fmt(p.workCompletion.timestamp)}.${p.workCompletion.remarks ? " " + esc(p.workCompletion.remarks) : ""} The Issuer may now close the permit.</div>` : ""}

    <div class="cols cols-2">
      <div class="card"><h3>Details</h3>
        ${kv("Equipment", `<span class="mono">${esc(p.equipmentTag)}</span> ${equip ? "· " + esc(equip.line) + " / " + esc(equip.area) : ""}`)}
        ${p.isoNo ? kv("Isolation cert.", `<a href="#" data-isolink class="mono">${esc(p.isoNo)}</a>`) : ""}
        ${kv("Requester", personHTML(p.requester?.name, p.requester))}
        ${kv("Department", esc(p.requestingDepartment?.department || "—") + (p.requestingDepartment?.subUnit ? " · " + esc(p.requestingDepartment.subUnit) : ""))}
        ${kv("Work", esc(p.workDescription))}
        ${p.location ? kv("Location", esc(p.location)) : ""}
        ${kv("Valid from", fmt(p.validity?.start))}
        ${kv("Valid to", p.validity?.openEnded ? "Open (while active)" : fmt(p.validity?.extendedTo || p.validity?.plannedEnd))}
        ${p.approval ? kv("Approved by", personHTML(p.approval.issuerName, p.approval) + " · " + fmt(p.approval.timestamp)) : ""}
        ${p.workCompletion ? kv("Work completed", personHTML(p.workCompletion.name, p.workCompletion) + " · " + fmt(p.workCompletion.timestamp) + (p.workCompletion.remarks ? " · " + esc(p.workCompletion.remarks) : "")) : ""}
        ${p.closure ? kv("Closed by", personHTML(p.closure.name, p.closure) + " · " + fmt(p.closure.timestamp) + (p.closure.remarks ? " · " + esc(p.closure.remarks) : "")) : ""}
      </div>
      <div class="card"><h3>Hazard checklist</h3>
        ${(p.checklist || []).map((c) => `<div class="checkline">${c.checked ? "☑" : "☐"} ${esc(c.item)}</div>`).join("") || "<div class='help'>None</div>"}
        <div class="section-title">PPE</div>
        ${(p.ppe || []).length ? p.ppe.map((x) => `<span class="chip">${esc(x)}</span> `).join("") : "<span class='help'>None specified</span>"}
        ${p.gasTest ? `<div class="section-title">Gas test</div>
          <div class="kv"><div class="k">O₂ / LEL / H₂S / CO</div><div class="v">${esc(p.gasTest.o2 || "—")} / ${esc(p.gasTest.lel || "—")} / ${esc(p.gasTest.h2s || "—")} / ${esc(p.gasTest.co || "—")}</div></div>
          ${p.gasTest.by ? `<div class="kv"><div class="k">Tested by</div><div class="v">${esc(p.gasTest.by)}</div></div>` : ""}` : ""}
      </div>
    </div>

    ${p.isolationPoints?.length || p.isolationRef ? `<div class="card"><h3>Isolation / LOTO</h3>
      ${p.isolationRef ? `<div class="info-box">Isolation certificate <a href="#" data-isolink2 class="mono">${esc(p.isoNo || p.isolationRef)}</a> on ${esc(p.equipmentTag)}${isoDoc ? " — " + (isoDoc.status === "assigned" ? "awaiting confirmation by " + personHTML(isoDoc.assignedTo?.name, isoDoc.assignedTo) : "status: " + esc(isoDoc.status)) : ""}.</div>` : ""}
      <table class="tbl"><thead><tr><th>Point</th><th>Method</th><th>Lock / tag</th></tr></thead><tbody>
        ${(p.isolationPoints || []).map((i) => `<tr><td>${esc(i.point)}</td><td>${esc(i.method || "—")}</td><td>${esc(i.lockTag || "—")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No points listed</td></tr>`}
      </tbody></table></div>` : ""}

    ${p.trialRuns?.length ? `<div class="card"><h3>Trial run log</h3>
      ${p.trialRuns.map((t) => `<div class="kv"><div class="k">${fmt(t.authorisedAt || t.requestedAt)}</div>
        <div class="v">Authorised by ${personHTML(t.authorisedBy, t.authorisedByMeta)} · ${t.reIsolatedAt ? "Re-isolated " + fmt(t.reIsolatedAt) : "OPEN"}</div></div>`).join("")}</div>` : ""}
  `;

  // bind actions
  $("#pdf") && ($("#pdf").onclick = () => printPermit(p, equip));
  $$("[data-isolink],[data-isolink2],[data-isolink3]").forEach((a) => a.onclick = (e) => { e.preventDefault(); go("isodetail", { id: p.isolationRef }); });
  $("#godeiso") && ($("#godeiso").onclick = () => go("isodetail", { id: p.isolationRef }));
  $("#editDraft") && ($("#editDraft").onclick = () => go("new", { editId: id }));
  $("#submitNow") && ($("#submitNow").onclick = async () => { await updateDoc(doc(db, "permits", id), { status: "submitted", updatedAt: nowISO() }); toast("Submitted", "ok"); go("detail", { id }); });
  $("#reject") && ($("#reject").onclick = () => {
    modal({ title: "Reject permit", body: `<label class="field"><span>Reason</span><textarea id="rr" placeholder="Why is this being rejected?"></textarea></label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>Reject</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = async () => {
      // Read the certificate (if any) first, then commit every change in one batch.
      let isoX = null;
      if (p.isolationRef) { const s = await getDoc(doc(db, "isolations", p.isolationRef)); if (s.exists()) isoX = s.data(); }
      const batch = writeBatch(db);
      batch.update(doc(db, "permits", id), { status: "rejected", rejection: { by: State.profile.id, byName: State.profile.name, ...myMeta(), reason: $("#rr").value.trim(), timestamp: nowISO() }, updatedAt: nowISO() });
      if (isoX) {
        const isoRef = doc(db, "isolations", p.isolationRef);
        const remCount = (isoX.attachedPermitIds || []).filter((x) => x !== id).length;
        if (remCount) batch.update(isoRef, { attachedPermitIds: arrayRemove(id) });
        else if (isoX.status === "assigned") {
          batch.update(isoRef, { attachedPermitIds: [], status: "removed", removedAt: nowISO(), removalConfirmedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() }, removalNote: "Cancelled — permit rejected before isolation" });
          batch.update(doc(db, "equipment", p.equipmentRef), { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
        } else batch.update(isoRef, { attachedPermitIds: [], status: "removalPending" });
      }
      await batch.commit();
      closeModal(); toast("Permit rejected"); go("detail", { id }); refreshPendingBadge();
    };
  });
  $("#approve") && ($("#approve").onclick = () => approvePermit(p, equip));
  $("#extend") && ($("#extend").onclick = () => {
    const curEnd = (p.validity?.extendedTo || p.validity?.plannedEnd || "").slice(0, 16);
    modal({ title: "Extend permit", body: `<label class="field"><span>New end date/time</span><input type="datetime-local" id="ne" value="${curEnd}"></label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-primary" data-ok>Extend</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = async () => {
      const ne = $("#ne").value;
      if (!ne) return toast("Pick a new end date/time", "err");
      if (new Date(ne) <= new Date()) return toast("The new end must be in the future.", "err");
      await updateDoc(doc(db, "permits", id), { status: "extended", "validity.extendedTo": ne, "validity.openEnded": false, updatedAt: nowISO() });
      closeModal(); toast("Permit extended", "ok"); go("detail", { id });
    };
  });
  $("#workdone") && ($("#workdone").onclick = () => confirmWorkComplete(p, equip));
  $("#close") && ($("#close").onclick = () => closePermit(p, equip));
  $("#trial") && ($("#trial").onclick = () => trialRun(p, equip));
  $("#reiso") && ($("#reiso").onclick = () => offerReisolate(p, equip));
}

/* -------------------- 6. Permit + isolation logic -------------------- */
async function approvePermit(p, equip) {
  const type = State.config.permitTypes.find((t) => t.code === p.type);
  const approval = () => ({ issuerUid: State.profile.id, issuerName: State.profile.name, ...myMeta(), timestamp: nowISO() });

  // --- non-isolation permits: approve straight to Active ---
  if (!type.requiresIsolation) {
    // Safety cross-check: warn the Issuer if the equipment is currently isolated
    // / energised for a trial, or already carries other live permits.
    let warn = "";
    const eqStatus = equip?.isolationStatus;
    if (eqStatus === "isolated" || eqStatus === "pending") warn += `<div class="warn-box">${esc(equip.tag)} is currently under an <b>isolation (LOTO)</b> for other work. Confirm this work is compatible before activating.</div>`;
    if (eqStatus === "trialRun") warn += `<div class="danger-box"><b>${esc(equip.tag)} is ENERGISED for a trial run.</b> Do not activate work that needs it de-energised.</div>`;
    const others = (await fetchPermits()).filter((x) => x.id !== p.id && x.equipmentRef === p.equipmentRef && ["active", "extended"].includes(x.status));
    if (others.length) warn += `<div class="warn-box"><b>${others.length} other active permit(s)</b> already on ${esc(p.equipmentTag)}. Review concurrent work.</div>`;
    confirmBoxHTML("Approve permit", `${warn}<p>Approve <b>${esc(p.permitNo)}</b> and activate the work?</p>`, "Approve & activate", async () => {
      await updateDoc(doc(db, "permits", p.id), { status: "active", approval: approval(), updatedAt: nowISO() });
      closeModal(); toast("Permit approved & activated", "ok"); go("detail", { id: p.id }); refreshPendingBadge();
    });
    return;
  }

  // --- isolation permits: certificate chain ---
  let iso = null;
  if (equip?.activeIsolationId) {
    const s = await getDoc(doc(db, "isolations", equip.activeIsolationId));
    if (s.exists()) iso = { id: s.id, ...s.data() };
  }

  if (iso && ["active", "trialRun"].includes(iso.status)) {
    // shared isolation already confirmed → attach, permit goes Active
    confirmBoxHTML("Approve permit",
      `<div class="info-box">${esc(equip.tag)} is already isolated under certificate <b class="mono">${esc(iso.isoNo || "")}</b>. This permit will <b>attach to the shared isolation</b> and become Active immediately.</div>
       <p>Approve <b>${esc(p.permitNo)}</b>?</p>`, "Approve & attach", async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "isolations", iso.id), { attachedPermitIds: arrayUnion(p.id) });
      batch.update(doc(db, "permits", p.id), { status: "active", isolationRef: iso.id, isoNo: iso.isoNo || null, approval: approval(), updatedAt: nowISO() });
      await batch.commit();
      closeModal(); toast("Permit approved & attached to isolation", "ok"); go("detail", { id: p.id }); refreshPendingBadge();
    });
    return;
  }

  if (iso && iso.status === "assigned") {
    // isolation assigned but not yet confirmed → attach, permit waits
    confirmBoxHTML("Approve permit",
      `<div class="warn-box">Isolation certificate <b class="mono">${esc(iso.isoNo || "")}</b> for ${esc(equip.tag)} is assigned to <b>${esc(iso.assignedTo?.name || "")}</b> and awaiting confirmation. This permit will attach to it and activate automatically once the isolation is confirmed.</div>
       <p>Approve <b>${esc(p.permitNo)}</b>?</p>`, "Approve & attach", async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "isolations", iso.id), { attachedPermitIds: arrayUnion(p.id) });
      batch.update(doc(db, "permits", p.id), { status: "awaitingIsolation", isolationRef: iso.id, isoNo: iso.isoNo || null, approval: approval(), updatedAt: nowISO() });
      await batch.commit();
      closeModal(); toast("Approved — awaiting isolation confirmation"); go("detail", { id: p.id }); refreshPendingBadge();
    });
    return;
  }

  // no usable isolation → create a new certificate and assign it
  const users = await isolatorUsers();
  if (!users.length) return toast("No active Isolator users found. Ask an Admin to assign the Isolator role to a user first.", "err");
  modal({ title: "Approve & create isolation certificate", wide: true, body: `
    <div class="info-box">A new <b>isolation certificate</b> with its own reference number will be created for <b>${esc(equip?.tag || "")}</b>. The permit stays <b>Awaiting Isolation</b> until the assigned person confirms in the app that the isolation is physically applied.</div>
    <div class="section-title">Isolation points (from the permit)</div>
    ${(p.isolationPoints || []).map((i) => `<div class="checkline">• ${esc(i.point)}${i.method ? " — " + esc(i.method) : ""}${i.lockTag ? " · " + esc(i.lockTag) : ""}</div>`).join("") || "<div class='help'>No points listed — they can be completed at confirmation.</div>"}
    <label class="field" style="margin-top:.8rem"><span>Assign isolation to <span class="req">*</span></span>
      <select id="assignTo">${users.map((u) => `<option value="${u.id}">${esc(u.name)}${(u.jobTitle || u.position) ? " — " + esc(u.jobTitle || u.position) : ""}</option>`).join("")}</select></label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Approve & assign isolation</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => {
    const au = users.find((u) => u.id === $("#assignTo").value);
    const isoId = uid(); const isoNo = makeIsoNo();
    const batch = writeBatch(db);
    batch.set(doc(db, "isolations", isoId), {
      isoNo, equipmentRef: equip.id, equipmentTag: equip.tag,
      points: p.isolationPoints || [], status: "assigned",
      assignedTo: { uid: au?.id || null, name: au?.name || "", ...userMeta(au) }, assignedBy: { uid: State.profile.id, name: State.profile.name, ...myMeta() }, assignedAt: nowISO(),
      confirmedBy: null, confirmedAt: null,
      removalAssignedTo: null, removalAssignedAt: null, removalConfirmedBy: null, removedAt: null,
      attachedPermitIds: [p.id], createdBy: State.profile.name, createdByMeta: myMeta(), createdAt: nowISO()
    });
    batch.update(doc(db, "equipment", equip.id), { isolationStatus: "pending", activeIsolationId: isoId, updatedAt: nowISO() });
    batch.update(doc(db, "permits", p.id), { status: "awaitingIsolation", isolationRef: isoId, isoNo, approval: approval(), updatedAt: nowISO() });
    await batch.commit();
    closeModal(); toast(`Certificate ${isoNo} assigned to ${au?.name || ""}`, "ok"); go("detail", { id: p.id }); refreshPendingBadge();
  };
}

// Requester's written sign-off that the job is finished and the equipment is
// safe to return to service. The permit cannot be closed until this is on record.
async function confirmWorkComplete(p, equip) {
  const isolated = !!p.isolationRef;
  modal({ title: "Confirm work complete", wide: true, body: `
    <div class="info-box">Confirm the work under permit <b class="mono">${esc(p.permitNo)}</b> on <b>${esc(p.equipmentTag || "")}</b> is finished and the equipment is safe to return to service.${isolated ? " An Isolator will then de-isolate the equipment, after which the Issuer can close the permit." : " The Issuer can then close the permit."}</div>
    <label class="field"><span>Completion remarks <span class="req">*</span></span><textarea id="wcRemarks" placeholder="Work completed, tools and personnel removed, area cleared…"></textarea></label>
    <label class="checkline"><input type="checkbox" id="wcAck"> I confirm the work is complete and <b>${esc(p.equipmentTag || "the equipment")}</b> is safe to return to service.</label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Confirm work complete</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => {
    const remarks = $("#wcRemarks").value.trim();
    if (!remarks) return toast("Enter completion remarks", "err");
    if (!$("#wcAck").checked) return toast("Tick the confirmation statement", "err");
    try {
      await updateDoc(doc(db, "permits", p.id), {
        workCompletion: { by: State.profile.id, name: State.profile.name, ...myMeta(), remarks, safeToReturn: true, timestamp: nowISO() },
        updatedAt: nowISO()
      });
      closeModal(); toast(isolated ? "Work complete — equipment can now be de-isolated" : "Work complete — Issuer can now close the permit", "ok"); go("detail", { id: p.id });
    } catch (e) { toast(e.message || "Could not confirm work completion", "err"); }
  };
}

async function closePermit(p, equip) {
  // Hand-back gates: requester signs off work → Isolator de-isolates → Issuer
  // closes. The de-isolation now happens on the certificate before this point,
  // so closing is a clean final step (no inline lock removal here).
  if (!p.workCompletion) return toast("The requester must confirm the work is complete before this permit can be closed.", "err");
  let iso = null;
  if (p.isolationRef) {
    const s = await getDoc(doc(db, "isolations", p.isolationRef));
    if (s.exists()) iso = { id: s.id, ...s.data() };
  }
  if (iso && iso.status === "trialRun") return toast("Re-isolate after the trial run before closing", "err");
  if (iso && iso.status !== "removed") return toast("An Isolator must de-isolate the equipment before this permit can be closed.", "err");

  confirmBoxHTML("Close permit",
    `<div class="info-box">Work is complete${iso ? " and <b>" + esc(p.equipmentTag || "the equipment") + "</b> has been de-isolated and returned to service" : ""}. Closing finalises permit <b class="mono">${esc(p.permitNo)}</b>.</div>
     <label class="field"><span>Closure remarks</span><textarea id="crem" placeholder="Work complete, area cleared…"></textarea></label>`,
    "Close permit", async () => {
      const remarks = $("#crem")?.value.trim() || "";
      await updateDoc(doc(db, "permits", p.id), { status: "closed", closure: { by: State.profile.id, name: State.profile.name, ...myMeta(), remarks, timestamp: nowISO() }, updatedAt: nowISO() });
      closeModal(); toast("Permit closed", "ok"); go("detail", { id: p.id });
    });
}

async function trialRun(p, equip) {
  const isoRef = p.isolationRef ? doc(db, "isolations", p.isolationRef) : null;
  const iso = isoRef ? (await getDoc(isoRef)).data() : null;
  const others = (iso?.attachedPermitIds || []).filter((x) => x !== p.id);
  modal({ title: "Start trial run", wide: true, body: `
    <div class="danger-box">A trial run temporarily <b>energises ${esc(equip?.tag)}</b>. All crews must be clear before you proceed.</div>
    ${others.length ? `<div class="warn-box">${others.length} other permit(s) share this isolation. Confirm those crews are clear too.</div>` : ""}
    <label class="checkline"><input type="checkbox" id="clr1"> All personnel are clear of the equipment</label>
    <label class="checkline"><input type="checkbox" id="clr2"> All crews on this equipment have been notified</label>
    <label class="checkline"><input type="checkbox" id="clr3"> I authorise temporary de-isolation for the trial run</label>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-danger" data-ok>De-isolate & start trial</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => {
    if (!($("#clr1").checked && $("#clr2").checked && $("#clr3").checked)) return toast("Confirm all three checks", "err");
    const tr = { requestedBy: State.profile.name, requestedAt: nowISO(), authorisedBy: State.profile.name, authorisedByMeta: myMeta(), authorisedAt: nowISO(), reIsolatedAt: null, status: "open" };
    const batch = writeBatch(db);
    batch.update(doc(db, "permits", p.id), { trialRuns: arrayUnion(tr), updatedAt: nowISO() });
    if (isoRef) batch.update(isoRef, { status: "trialRun" });
    if (equip) batch.update(doc(db, "equipment", equip.id), { isolationStatus: "trialRun", updatedAt: nowISO() });
    await batch.commit();
    closeModal(); toast("Trial run started — equipment energised", "");
    // offer re-isolate immediately
    setTimeout(() => offerReisolate(p, equip), 400);
    go("detail", { id: p.id });
  };
}
function offerReisolate(p, equip) {
  confirmBoxHTML("Trial run in progress", `<div class="danger-box"><b>${esc(equip?.tag)} is ENERGISED.</b></div>
    <p>When the trial is complete, re-isolate to resume work, or close the permit if the job is done.</p>`,
    "Re-isolate now", async () => {
      const snap = await getDoc(doc(db, "permits", p.id)); const pp = snap.data();
      const trs = (pp.trialRuns || []).map((t, i, a) => i === a.length - 1 ? { ...t, reIsolatedAt: nowISO(), status: "closed" } : t);
      const batch = writeBatch(db);
      batch.update(doc(db, "permits", p.id), { trialRuns: trs, updatedAt: nowISO() });
      if (p.isolationRef) batch.update(doc(db, "isolations", p.isolationRef), { status: "active" });
      if (equip) batch.update(doc(db, "equipment", equip.id), { isolationStatus: "isolated", updatedAt: nowISO() });
      await batch.commit();
      closeModal(); toast("Re-isolated — work may resume", "ok"); go("detail", { id: p.id });
    });
}

// HTML-body confirm variant
function confirmBoxHTML(title, bodyHtml, okLabel, onOk, danger = false) {
  modal({ title, body: bodyHtml, footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(okLabel)}</button>` });
  $("[data-c]").onclick = closeModal;
  $("[data-ok]").onclick = async () => { try { await onOk(); } catch (e) { toast(e.message || "Error", "err"); } };
}

/* -------------------- 5e. Equipment -------------------- */
async function viewEquipment(m) {
  const isIssuer = ["issuer", "admin"].includes(State.profile.role);
  m.innerHTML = `<div class="page-head"><div><div class="kick">Asset register</div><h2>Equipment</h2></div>
    <div class="actions">${isIssuer ? `<button class="btn btn-ghost" id="imp">Import CSV</button><button class="btn btn-accent" id="add">+ Add equipment</button>` : ""}</div></div>
    <div class="filters"><input class="search" id="q" placeholder="Search tag or name…">
      <select id="fLine"><option value="">All lines</option>${State.config.lines.map((l) => `<option>${esc(l)}</option>`).join("")}</select>
      <select id="fArea"><option value="">All areas</option>${State.config.areas.map((a) => `<option>${esc(a)}</option>`).join("")}</select></div>
    <div class="card pad0" id="etable">Loading…</div>`;
  let equip = await fetchEquipment();
  const draw = () => {
    const q = $("#q").value.toLowerCase(), fl = $("#fLine").value, fa = $("#fArea").value;
    const rows = equip.filter((e) => (!fl || e.line === fl) && (!fa || e.area === fa) && (!q || (e.tag + " " + e.description).toLowerCase().includes(q)));
    $("#etable").innerHTML = `<table class="tbl"><thead><tr><th>Tag</th><th>Description</th><th>Line</th><th>Area</th><th>Status</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td><span class="mono">${esc(e.tag)}</span></td><td>${esc(e.description || "—")}</td><td>${esc(e.line)}</td><td>${esc(e.area)}</td><td>${badge(e.isolationStatus || "available")}</td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">No equipment yet. ${isIssuer ? "Add one or import a CSV." : ""}</td></tr>`}</tbody></table>`;
  };
  ["q", "fLine", "fArea"].forEach((id) => $("#" + id).addEventListener("input", draw));
  draw();
  if (isIssuer) {
    $("#add").onclick = () => openAddEquipment(equip, (added) => { equip.push(added); draw(); });
    $("#imp").onclick = () => openImport(equip, (newList) => { equip = newList; draw(); });
  }
}

function openAddEquipment(existing, onAdded) {
  const cfg = State.config;
  modal({ title: "Add equipment", body: `
    <label class="field"><span>Tag <span class="req">*</span></span><input type="text" id="aTag" placeholder="e.g. 362FN1"></label>
    <div id="dupWarn"></div>
    <label class="field"><span>Description</span><input type="text" id="aDesc" placeholder="e.g. Raw Mill Circulation Fan"></label>
    <div class="grid-2">
      <label class="field"><span>Line</span><select id="aLine">${cfg.lines.map((l) => `<option>${esc(l)}</option>`).join("")}</select></label>
      <label class="field"><span>Area</span><select id="aArea">${cfg.areas.map((a) => `<option>${esc(a)}</option>`).join("")}</select></label>
    </div>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok>Add</button>` });
  $("[data-c]").onclick = closeModal;
  const tagInput = $("#aTag");
  tagInput.addEventListener("input", () => {
    const t = tagInput.value.trim().toLowerCase();
    const dup = existing.find((e) => e.tag.toLowerCase() === t || (t && e.tag.toLowerCase().includes(t) && t.length > 2));
    $("#dupWarn").innerHTML = dup ? `<div class="warn-box">Possible duplicate: <b class="mono">${esc(dup.tag)}</b> ${esc(dup.description || "")}. Check before adding.</div>` : "";
  });
  $("[data-ok]").onclick = async () => {
    const tag = tagInput.value.trim();
    if (!tag) return toast("Enter a tag", "err");
    if (existing.some((e) => e.tag.toLowerCase() === tag.toLowerCase())) return toast("That tag already exists", "err");
    const rec = { tag, description: $("#aDesc").value.trim(), line: $("#aLine").value, area: $("#aArea").value, isolationStatus: "available", activeIsolationId: null, createdBy: State.profile.name, createdAt: nowISO() };
    try { const ref = await addDoc(collection(db, "equipment"), rec); closeModal(); toast("Equipment added", "ok"); onAdded({ id: ref.id, ...rec }); }
    catch (e) { toast(e.message, "err"); }
  };
}

function openImport(existing, onDone) {
  modal({ title: "Import equipment (CSV)", wide: true, body: `
    <div class="info-box">CSV columns: <b>tag, description, line, area</b> (first row = header). Existing tags are skipped (no duplicates).</div>
    <input type="file" id="csv" accept=".csv,text/csv">
    <div id="prev" style="margin-top:1rem"></div>`,
    footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-accent" data-ok disabled>Import</button>` });
  $("[data-c]").onclick = closeModal;
  let parsed = [];
  $("#csv").onchange = (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const lines = r.result.split(/\r?\n/).filter((x) => x.trim());
      const head = parseCsvLine(lines.shift()).map((h) => h.toLowerCase());
      const idx = (k) => head.indexOf(k);
      parsed = lines.map((ln) => { const c = parseCsvLine(ln); return {
        tag: (c[idx("tag")] || "").trim(), description: (c[idx("description")] || "").trim(),
        line: (c[idx("line")] || State.config.lines[0]).trim(), area: (c[idx("area")] || State.config.areas[0]).trim() }; })
        .filter((x) => x.tag && !existing.some((e) => e.tag.toLowerCase() === x.tag.toLowerCase()));
      $("#prev").innerHTML = `<b>${parsed.length}</b> new rows ready (duplicates skipped).`;
      $("[data-ok]").disabled = parsed.length === 0;
    };
    r.readAsText(file);
  };
  $("[data-ok]").onclick = async () => {
    $("[data-ok]").disabled = true;
    try {
      for (const x of parsed) await addDoc(collection(db, "equipment"), { ...x, isolationStatus: "available", activeIsolationId: null, createdBy: State.profile.name, createdAt: nowISO() });
      closeModal(); toast(`Imported ${parsed.length} equipment`, "ok");
      onDone(await fetchEquipment());
    } catch (e) { toast(e.message, "err"); }
  };
}

/* -------------------- 5f. Administration -------------------- */
async function viewAdmin(m) {
  m.innerHTML = `<div class="page-head"><div><div class="kick">Administration</div><h2>Users & Configuration</h2></div></div>
    <div class="card pad0"><div style="padding:1rem 1.3rem;border-bottom:1px solid var(--line)"><h3>Users</h3></div>
      <div id="users">Loading…</div></div>
    <div class="card"><h3>Configuration</h3><div class="csub">Permit types, lines, areas and departments are stored in <span class="mono">config/app</span>. Edit lists below.</div>
      <div class="cols cols-2">
        <div><div class="section-title">Lines</div><textarea id="cLines" rows="4">${esc((State.config.lines || []).join("\n"))}</textarea></div>
        <div><div class="section-title">Areas</div><textarea id="cAreas" rows="6">${esc((State.config.areas || []).join("\n"))}</textarea></div>
      </div>
      <div class="section-title">Departments (format: Department: sub, sub, sub)</div>
      <textarea id="cDepts" rows="4">${esc((State.config.departments || []).map((d) => d.name + (d.subUnits?.length ? ": " + d.subUnits.join(", ") : "")).join("\n"))}</textarea>
      <div class="section-title">PPE options</div>
      <textarea id="cPpe" rows="3">${esc((State.config.ppeList || []).join("\n"))}</textarea>
      <div class="section-title">Job Titles (one per line — order is preserved; used in sign-up and user management)</div>
      <textarea id="cTitles" rows="6">${esc(jobTitles().join("\n"))}</textarea>
      <div style="margin-top:1rem;text-align:right"><button class="btn btn-accent" id="saveCfg">Save configuration</button></div>
    </div>`;
  // users
  const users = await fetchAll("users");
  $("#users").innerHTML = `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Job Title</th><th>Department</th><th>Employee No.</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email || "—")}</td>
      <td><select data-jt="${u.id}">${optionList(jobTitles(), u.jobTitle || u.position || "")}</select></td>
      <td><select data-dp="${u.id}">${optionList(departmentNames(), u.department || "")}</select></td>
      <td><input type="text" data-en="${u.id}" value="${esc(u.employeeNumber || "")}" placeholder="EMP-…" style="min-width:110px"></td>
      <td><select data-role="${u.id}" ${u.id === State.profile.id ? "disabled" : ""}>
        ${["requester", "issuer", "admin", "isolator"].map((r) => `<option ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
      <td><label class="checkline" style="padding:0"><input type="checkbox" data-active="${u.id}" ${u.active ? "checked" : ""} ${u.id === State.profile.id ? "disabled" : ""}></label></td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-saveu="${u.id}">Save</button>
        ${u.email ? `<button class="btn btn-ghost btn-sm" data-resetu="${esc(u.email)}">Reset PW</button>` : ""}
        ${u.id === State.profile.id ? "" : `<button class="btn btn-danger btn-sm" data-delu="${u.id}" data-name="${esc(u.name || u.email || "this user")}">Delete</button>`}
      </td></tr>`).join("")}</tbody></table></div>`;
  $$("[data-saveu]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.saveu;
    const role = $(`[data-role="${id}"]`).value, active = $(`[data-active="${id}"]`).checked;
    const jobTitle = $(`[data-jt="${id}"]`).value, department = $(`[data-dp="${id}"]`).value, employeeNumber = $(`[data-en="${id}"]`).value.trim();
    try { await updateDoc(doc(db, "users", id), { role, active, jobTitle, department, employeeNumber }); toast("User updated", "ok"); } catch (e) { toast(e.message, "err"); }
  });
  $$("[data-resetu]").forEach((b) => b.onclick = async () => {
    try { await sendPasswordResetEmail(auth, b.dataset.resetu); toast(`Password reset email sent to ${b.dataset.resetu}`, "ok"); }
    catch (e) { toast(friendlyAuthError(e), "err"); }
  });
  $$("[data-delu]").forEach((b) => b.onclick = () => confirmBox(
    "Delete user",
    `Remove ${b.dataset.name} from the system? They lose all access immediately. Their sign-in credential remains but is inert until an Admin re-approves them.`,
    "Delete user",
    async () => { await deleteDoc(doc(db, "users", b.dataset.delu)); closeModal(); toast("User deleted", "ok"); go("admin"); },
    true));
  // config save
  $("#saveCfg").onclick = async () => {
    const lines = $("#cLines").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const areas = $("#cAreas").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const ppeList = $("#cPpe").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const jobTitlesList = $("#cTitles").value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const departments = $("#cDepts").value.split(/\n/).map((s) => s.trim()).filter(Boolean).map((ln) => {
      const [name, subs] = ln.split(":"); return { name: name.trim(), subUnits: (subs || "").split(",").map((x) => x.trim()).filter(Boolean) };
    });
    try {
      await updateDoc(doc(db, "config", "app"), { lines, areas, ppeList, departments, jobTitles: jobTitlesList });
      State.config = { ...State.config, lines, areas, ppeList, departments, jobTitles: jobTitlesList };
      toast("Configuration saved", "ok");
    } catch (e) { toast(e.message, "err"); }
  };
}

/* -------------------- 7. Print / PDF -------------------- */
function printPermit(p, equip) {
  const row = (k, v) => `<tr><td style="padding:4px 10px;color:#555;width:170px">${k}</td><td style="padding:4px 10px;font-weight:600">${v}</td></tr>`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#15293B;max-width:760px;margin:0 auto;padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #0E2A47;padding-bottom:10px">
        <div><div style="font-size:20px;font-weight:800">WORK PERMIT</div>
          <div style="color:#666">${esc(appBranding.company)} · ${esc(appBranding.site)}</div></div>
        <div style="text-align:right"><div style="font-size:18px;font-weight:800;color:#0E2A47">${esc(p.permitNo)}</div>
          <div style="color:#666">${esc(p.typeName)}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:14px">
        ${row("Status", esc(p.status.toUpperCase()))}
        ${row("Equipment", esc(p.equipmentTag) + (equip ? " · " + esc(equip.line) + " / " + esc(equip.area) : ""))}
        ${p.isoNo ? row("Isolation certificate", esc(p.isoNo)) : ""}
        ${row("Requester", personHTML(p.requester?.name, p.requester))}
        ${row("Department", esc(p.requestingDepartment?.department || "—") + (p.requestingDepartment?.subUnit ? " · " + esc(p.requestingDepartment.subUnit) : ""))}
        ${row("Work", esc(p.workDescription))}
        ${row("Valid from", fmt(p.validity?.start))}
        ${row("Valid to", p.validity?.openEnded ? "Open (while active)" : fmt(p.validity?.extendedTo || p.validity?.plannedEnd))}
        ${p.approval ? row("Approved by", personHTML(p.approval.issuerName, p.approval) + " · " + fmt(p.approval.timestamp)) : ""}
        ${p.workCompletion ? row("Work completed / safe to return", personHTML(p.workCompletion.name, p.workCompletion) + " · " + fmt(p.workCompletion.timestamp) + (p.workCompletion.remarks ? " · " + esc(p.workCompletion.remarks) : "")) : ""}
        ${p.closure ? row("Closed by", personHTML(p.closure.name, p.closure) + " · " + fmt(p.closure.timestamp)) : ""}
      </table>
      <div style="margin-top:14px;font-weight:800;color:#2A6F97;font-size:13px">HAZARD CHECKLIST</div>
      <div>${(p.checklist || []).map((c) => `<div>${c.checked ? "☑" : "☐"} ${esc(c.item)}</div>`).join("")}</div>
      <div style="margin-top:10px;font-weight:800;color:#2A6F97;font-size:13px">PPE</div>
      <div>${(p.ppe || []).join(", ") || "—"}</div>
      ${p.isolationPoints?.length ? `<div style="margin-top:10px;font-weight:800;color:#2A6F97;font-size:13px">ISOLATION REGISTER</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #ccc"><tr style="background:#f2f5f8"><th style="text-align:left;padding:5px">Point</th><th style="text-align:left;padding:5px">Method</th><th style="text-align:left;padding:5px">Lock/Tag</th></tr>
        ${p.isolationPoints.map((i) => `<tr><td style="padding:5px;border-top:1px solid #eee">${esc(i.point)}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.method || "")}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.lockTag || "")}</td></tr>`).join("")}</table>` : ""}
      ${p.gasTest ? `<div style="margin-top:10px;font-weight:800;color:#2A6F97;font-size:13px">GAS TEST</div><div>O₂ ${esc(p.gasTest.o2 || "—")} · LEL ${esc(p.gasTest.lel || "—")} · H₂S ${esc(p.gasTest.h2s || "—")} · CO ${esc(p.gasTest.co || "—")} ${p.gasTest.by ? "· by " + esc(p.gasTest.by) : ""}</div>` : ""}
      <div style="margin-top:34px;display:flex;justify-content:space-between">
        <div style="border-top:1px solid #333;width:42%;padding-top:5px;font-size:12px">Requester signature</div>
        <div style="border-top:1px solid #333;width:42%;padding-top:5px;font-size:12px">Issuer signature</div>
      </div>
      <div style="margin-top:20px;color:#999;font-size:11px">Generated ${fmt(nowISO())} · NRCC Work Permit System</div>
    </div>`;
  $("#print-area").innerHTML = html;
  window.print();
}

/* -------------------- 8. Isolation certificates -------------------- */
function makeIsoNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `NRCC-ISO-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function tabsHtml(cur) {
  return `<div style="display:flex;gap:.5rem;margin-bottom:1rem">
    <button class="btn ${cur === "p" ? "btn-primary" : "btn-ghost"} btn-sm" data-tabp>Work Permits</button>
    <button class="btn ${cur === "i" ? "btn-primary" : "btn-ghost"} btn-sm" data-tabi>Isolation Certificates</button></div>`;
}
function bindTabs() {
  const a = $("[data-tabp]"), b = $("[data-tabi]");
  if (a) a.onclick = () => go("permits");
  if (b) b.onclick = () => go("isolations");
}

async function viewIsolations(m) {
  m.innerHTML = `<div class="page-head"><div><div class="kick">Records</div><h2>Isolation Certificates</h2></div></div>
    ${tabsHtml("i")}
    <div class="filters"><input class="search" id="q" placeholder="Search certificate no or equipment…">
      <select id="fs"><option value="">All statuses</option>${["assigned", "active", "trialRun", "removalPending", "removed"].map((s) => `<option>${s}</option>`).join("")}</select></div>
    <div class="card pad0" id="itable">Loading…</div>`;
  bindTabs();
  const all = await fetchIsolations();
  const draw = () => {
    const q = $("#q").value.toLowerCase(), fs = $("#fs").value;
    const rows = all.filter((i) => (!fs || i.status === fs) && (!q || ((i.isoNo || "") + " " + i.equipmentTag).toLowerCase().includes(q)));
    $("#itable").innerHTML = `<table class="tbl"><thead><tr><th>Certificate</th><th>Equipment</th><th>Status</th><th>Assigned to</th><th>Permits</th><th>Created</th></tr></thead><tbody>
      ${rows.map((i) => `<tr class="row" data-iid="${i.id}">
        <td><span class="mono">${esc(i.isoNo || i.id)}</span></td><td>${esc(i.equipmentTag)}</td>
        <td>${badge(i.status)}</td><td>${esc(i.assignedTo?.name || "—")}</td>
        <td>${(i.attachedPermitIds || []).length}</td><td>${fmtDate(i.createdAt)}</td></tr>`).join("")
      || `<tr><td colspan="6" class="empty">No certificates yet — they are created when isolation permits are approved.</td></tr>`}</tbody></table>`;
    $$("tr.row[data-iid]").forEach((r) => r.onclick = () => go("isodetail", { id: r.dataset.iid }));
  };
  ["q", "fs"].forEach((id) => $("#" + id).addEventListener("input", draw));
  draw();
}

async function viewIsolationDetail(m) {
  m.innerHTML = `<div>Loading…</div>`;
  const id = State.params.id;
  const s = await getDoc(doc(db, "isolations", id));
  if (!s.exists()) { m.innerHTML = `<div class="danger-box">Certificate not found.</div>`; return; }
  const iso = { id, ...s.data() };
  const eqS = await getDoc(doc(db, "equipment", iso.equipmentRef)).catch(() => null);
  const equip = eqS && eqS.exists() ? { id: eqS.id, ...eqS.data() } : null;
  const permits = await fetchPermits();
  const attached = permits.filter((p) => p.isolationRef === id);
  const me = State.profile.id, canI = ["issuer", "admin"].includes(State.profile.role);
  const isAdmin = State.profile.role === "admin";
  // Any active Isolator may confirm — the lockout is done by whoever is on
  // shift, not only the named assignee. The actual signer is stamped below.
  const isIso = State.profile.role === "isolator";
  const canConfirm = iso.status === "assigned" && (canI || isIso || iso.assignedTo?.uid === me);
  // De-isolation opens automatically once all crews on a confirmed certificate
  // have signed off their work complete (readyForDeiso), as well as for any
  // certificate explicitly put into removalPending by an older flow.
  // De-isolation is the Isolator's physical job — the Issuer does NOT de-isolate
  // (Admin is kept only as a system superuser fallback).
  const readyForDeiso = isoReadyForDeiso(iso, permits);
  const canRemove = (iso.status === "removalPending" || readyForDeiso) && (isIso || isAdmin || iso.removalAssignedTo?.uid === me);
  // An active certificate with no open permits is orphaned — let an
  // Issuer/Admin release it directly to return the equipment to service.
  const openAttached = attached.filter((p) => ["draft", "submitted", "awaitingIsolation", "active", "extended"].includes(p.status));
  const canRelease = canI && iso.status === "active" && openAttached.length === 0;

  let actions = "";
  if (canConfirm) actions += `<button class="btn btn-success" id="conf">Confirm isolation applied</button>`;
  if (canRemove) actions += `<button class="btn btn-success" id="rem">Confirm de-isolation complete</button>`;
  if (canRelease) actions += `<button class="btn btn-danger" id="release">Release isolation (return to service)</button>`;
  actions += `<button class="btn btn-ghost no-print" id="ipdf">${ICON.pdf} Print / PDF</button>`;

  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  m.innerHTML = `
    <div class="page-head"><div><div class="kick">Isolation Certificate</div>
      <h2 style="display:flex;align-items:center;gap:.6rem"><span class="mono" style="font-size:1.1rem">${esc(iso.isoNo || iso.id)}</span> ${badge(iso.status)}</h2></div>
      <div class="actions">${actions}</div></div>
    ${iso.status === "assigned" ? `<div class="warn-box">Awaiting confirmation by <b>${personHTML(iso.assignedTo?.name, iso.assignedTo)}</b>. Work must not start until the isolation is confirmed.</div>` : ""}
    ${readyForDeiso ? `<div class="warn-box"><b>Ready for de-isolation.</b> All permits on this certificate have been confirmed work-complete, so <b>${esc(iso.equipmentTag)}</b> can now be de-isolated. <b>Locks are still ON</b> — an Isolator must confirm de-isolation before the Issuer can close the permit(s).</div>` : ""}
    ${iso.status === "removalPending" ? `<div class="warn-box">De-isolation assigned to <b>${iso.removalAssignedTo ? personHTML(iso.removalAssignedTo.name, iso.removalAssignedTo) : "(unassigned — any Isolator can action)"}</b>. Locks are still ON.</div>` : ""}
    ${canRelease ? `<div class="warn-box">This certificate is still <b>active</b> but has <b>no open permits</b>. As Issuer/Admin you can release it to return <b>${esc(iso.equipmentTag)}</b> to service.</div>` : ""}
    <div class="cols cols-2">
      <div class="card"><h3>Certificate</h3>
        ${kv("Equipment", `<span class="mono">${esc(iso.equipmentTag)}</span>${equip ? " · " + esc(equip.line) + " / " + esc(equip.area) : ""}`)}
        ${kv("Created", iso.createdBy ? personHTML(iso.createdBy, iso.createdByMeta) + " · " + fmt(iso.createdAt) : "—")}
        ${kv("Assigned to", iso.assignedTo ? personHTML(iso.assignedTo.name, iso.assignedTo) + " · " + fmt(iso.assignedAt) : "—")}
        ${kv("Isolation confirmed", iso.confirmedBy ? personHTML(iso.confirmedBy.name, iso.confirmedBy) + " · " + fmt(iso.confirmedAt) : "—")}
        ${iso.removalAssignedTo ? kv("De-isolation assigned", personHTML(iso.removalAssignedTo.name, iso.removalAssignedTo) + " · " + fmt(iso.removalAssignedAt)) : ""}
        ${kv("De-isolation confirmed", iso.removalConfirmedBy ? personHTML(iso.removalConfirmedBy.name, iso.removalConfirmedBy) + " · " + fmt(iso.removedAt) : "—")}
      </div>
      <div class="card"><h3>Attached permits</h3>
        <div class="attached-list">${attached.map((p) => `<div class="a" data-pl="${p.id}" style="cursor:pointer"><span class="mono">${esc(p.permitNo)}</span> ${esc(p.typeName)} ${badge(p.status)}</div>`).join("") || "<div class='help'>None</div>"}</div>
      </div>
    </div>
    <div class="card"><h3>Isolation points</h3>
      <table class="tbl"><thead><tr><th>Point</th><th>Method</th><th>Lock / tag</th></tr></thead><tbody>
        ${(iso.points || []).map((i) => `<tr><td>${esc(i.point)}</td><td>${esc(i.method || "—")}</td><td>${esc(i.lockTag || "—")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No points listed</td></tr>`}
      </tbody></table></div>`;

  $$("[data-pl]").forEach((d) => d.onclick = () => go("detail", { id: d.dataset.pl }));
  $("#ipdf").onclick = () => printIsolation(iso, equip, attached);

  if (canConfirm) $("#conf").onclick = () => {
    modal({ title: "Confirm isolation applied", wide: true, body: `
      <div class="info-box">Verify each point and enter the lock/tag number used, then confirm. Attached permits in \u201CAwaiting Isolation\u201D become Active automatically.</div>
      ${(iso.points || []).map((pt, i) => `<div class="iso-row"><input value="${esc(pt.point)}" disabled><input value="${esc(pt.method || "")}" disabled><input data-lk="${i}" placeholder="Lock / tag no." value="${esc(pt.lockTag || "")}"></div>`).join("") || "<div class='help'>No points were listed on the permit.</div>"}
      <label class="checkline" style="margin-top:.6rem"><input type="checkbox" id="ckAll"> I confirm all listed points are isolated, locked and tagged, and zero energy has been verified.</label>`,
      footer: `<button class="btn btn-ghost" data-c>Cancel</button><button class="btn btn-success" data-ok>Confirm isolation</button>` });
    $("[data-c]").onclick = closeModal;
    $("[data-ok]").onclick = async () => {
      if (!$("#ckAll").checked) return toast("Tick the confirmation statement", "err");
      const pts = (iso.points || []).map((pt, i) => ({ ...pt, lockTag: $(`[data-lk="${i}"]`)?.value.trim() || pt.lockTag || "" }));
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, "isolations", id), { points: pts, status: "active", confirmedBy: { uid: me, name: State.profile.name, ...myMeta() }, confirmedAt: nowISO() });
        if (equip) batch.update(doc(db, "equipment", equip.id), { isolationStatus: "isolated", updatedAt: nowISO() });
        for (const p of attached) if (p.status === "awaitingIsolation") batch.update(doc(db, "permits", p.id), { status: "active", updatedAt: nowISO() });
        await batch.commit();
        closeModal(); toast("Isolation confirmed — waiting permits activated", "ok"); go("isodetail", { id });
      } catch (e) { toast(e.message || "Could not confirm isolation", "err"); }
    };
  };

  if (canRemove) $("#rem").onclick = () => confirmBoxHTML("Confirm de-isolation",
    `<p>All locks and tags have been removed from <b>${esc(iso.equipmentTag)}</b>? The equipment returns to <b>Available</b>.</p>`,
    "Confirm de-isolation", async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "isolations", id), { status: "removed", removedAt: nowISO(), removalConfirmedBy: { uid: me, name: State.profile.name, ...myMeta() } });
      if (equip) batch.update(doc(db, "equipment", equip.id), { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
      await batch.commit();
      closeModal(); toast("De-isolation confirmed — equipment available", "ok"); go("isodetail", { id });
    });

  if (canRelease) $("#release").onclick = () => confirmBoxHTML("Release isolation",
    `<p>This certificate has <b>no open permits</b>. Confirm all locks and tags are removed from <b>${esc(iso.equipmentTag)}</b> and return it to <b>Available</b>?</p>`,
    "Release isolation", async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "isolations", id), { attachedPermitIds: [], status: "removed", removedAt: nowISO(), removalConfirmedBy: { uid: me, name: State.profile.name, ...myMeta() }, removalNote: "Released by Issuer/Admin — no open permits" });
      if (equip) batch.update(doc(db, "equipment", equip.id), { isolationStatus: "available", activeIsolationId: null, updatedAt: nowISO() });
      await batch.commit();
      closeModal(); toast("Isolation released — equipment available", "ok"); go("isodetail", { id });
    }, true);
}

function printIsolation(iso, equip, attached) {
  const row = (k, v) => `<tr><td style="padding:4px 10px;color:#555;width:190px">${k}</td><td style="padding:4px 10px;font-weight:600">${v}</td></tr>`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#15293B;max-width:760px;margin:0 auto;padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #0E2A47;padding-bottom:10px">
        <div><div style="font-size:20px;font-weight:800">ISOLATION CERTIFICATE</div>
          <div style="color:#666">${esc(appBranding.company)} · ${esc(appBranding.site)}</div></div>
        <div style="text-align:right"><div style="font-size:18px;font-weight:800;color:#0E2A47">${esc(iso.isoNo || iso.id)}</div>
          <div style="color:#666">Status: ${esc(iso.status.toUpperCase())}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:14px">
        ${row("Equipment", esc(iso.equipmentTag) + (equip ? " · " + esc(equip.line) + " / " + esc(equip.area) : ""))}
        ${row("Created by", iso.createdBy ? personHTML(iso.createdBy, iso.createdByMeta) + " · " + fmt(iso.createdAt) : "—")}
        ${row("Assigned to", iso.assignedTo ? personHTML(iso.assignedTo.name, iso.assignedTo) + " · " + fmt(iso.assignedAt) : "—")}
        ${row("Isolation confirmed", iso.confirmedBy ? personHTML(iso.confirmedBy.name, iso.confirmedBy) + " · " + fmt(iso.confirmedAt) : "—")}
        ${iso.removalAssignedTo ? row("De-isolation assigned", personHTML(iso.removalAssignedTo.name, iso.removalAssignedTo) + " · " + fmt(iso.removalAssignedAt)) : ""}
        ${row("De-isolation confirmed", iso.removalConfirmedBy ? personHTML(iso.removalConfirmedBy.name, iso.removalConfirmedBy) + " · " + fmt(iso.removedAt) : "—")}
      </table>
      <div style="margin-top:14px;font-weight:800;color:#2A6F97;font-size:13px">ISOLATION POINTS</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #ccc"><tr style="background:#f2f5f8"><th style="text-align:left;padding:5px">Point</th><th style="text-align:left;padding:5px">Method</th><th style="text-align:left;padding:5px">Lock/Tag</th></tr>
      ${(iso.points || []).map((i) => `<tr><td style="padding:5px;border-top:1px solid #eee">${esc(i.point)}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.method || "")}</td><td style="padding:5px;border-top:1px solid #eee">${esc(i.lockTag || "")}</td></tr>`).join("") || `<tr><td colspan="3" style="padding:6px">No points listed</td></tr>`}</table>
      <div style="margin-top:12px;font-weight:800;color:#2A6F97;font-size:13px">ATTACHED PERMITS</div>
      <div>${(attached || []).map((p) => esc(p.permitNo) + " (" + esc(p.status) + ")").join(" · ") || "—"}</div>
      <div style="margin-top:40px;display:flex;justify-content:space-between;gap:14px">
        <div style="border-top:1px solid #333;width:31%;padding-top:5px;font-size:12px">Assigned by (Issuer)</div>
        <div style="border-top:1px solid #333;width:31%;padding-top:5px;font-size:12px">Isolated by</div>
        <div style="border-top:1px solid #333;width:31%;padding-top:5px;font-size:12px">De-isolated by</div>
      </div>
      <div style="margin-top:20px;color:#999;font-size:11px">Generated ${fmt(nowISO())} · NRCC Work Permit System</div>
    </div>`;
  $("#print-area").innerHTML = html;
  window.print();
}

/* expose for inline handlers if any */
window.go = go;
