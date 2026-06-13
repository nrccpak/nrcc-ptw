# NRCC Work Permit System (PTW)

Offline-first Permit-to-Work web app for Northern Region Cement Company, Turaif.
Hosted on **GitHub Pages** (this repository) with **Firebase** providing login and the
database (Firestore, with built-in offline cache and auto-sync).

> **Full step-by-step instructions are in `NRCC_PTW_Setup_and_User_Manual.docx`**
> (if provided separately). Read that first — it covers Firebase setup,
> GitHub Pages deployment, daily use, and how to scale the system later.

---

## Quick facts

| | |
|---|---|
| Hosting | GitHub Pages (static files, this repo) |
| Login | Firebase Authentication — email + password |
| Database | Firestore with offline persistence (auto-sync when online) |
| App type | Installable PWA — works on phone and desktop |
| Permit types (v1) | General/Cold, Hot Work, Electrical Isolation (LOTO), Confined Space |
| Roles | Requester · Issuer · Isolator · Admin |
| Isolation | Separate NRCC-ISO certificates: Issuer assigns → electrician confirms → permits activate; de-isolation confirmed the same way |
| Safety logic | Shared isolation (multi-crew), last-permit-closes rule, trial-run sub-workflow |

## The one file you must edit

`firebase-config.js` — paste your Firebase project's config object here.
Nothing else needs changing to go live.

## File map (for maintenance and for Claude Code)

| File | What it does |
|------|--------------|
| `index.html` | App shell. Loads styles + app.js, registers the service worker. |
| `styles.css` | Entire visual theme (platinum). CSS variables at the top control colors. |
| `app.js` | All application logic, organised in numbered sections: 1 Firebase init · 2 State/helpers · 3 Auth/bootstrap · 4 Shell/router · 5 Views · 6 Permit/isolation/trial-run logic · 7 Print/PDF · 8 Isolation certificates (register, detail, confirm/de-isolation, print). |
| `firebase-config.js` | Your Firebase keys + branding. **Only file you edit at setup.** |
| `firestore.rules` | Security rules — paste into Firebase Console → Firestore → Rules. |
| `service-worker.js` | Caches the app shell for offline. Bump `CACHE_VERSION` when you change files. |
| `manifest.webmanifest` | PWA manifest (name, icons, colors). |
| `icons/` | App icons. |
| `sample-equipment.csv` | Example CSV for the equipment Import function. |

## Scaling later (designed for it)

Permit types, checklists, lines, areas, departments and PPE all live in **Firestore
`config/app`** — editable from the Admin screen, no code change needed for a 5th
permit type. Bigger features (QR codes, drawn signatures, a second approval step,
notifications, KPI dashboard) each have a clear hook point in `app.js`; see the
"Scaling & Customisation" chapter of the manual for the exact map.

When using **Claude Code** on this repo, point it at this README and the manual —
the section numbering in `app.js` is the intended navigation aid.

## Updating the live app

1. Edit files in this repo (GitHub web editor is fine).
2. Bump `CACHE_VERSION` in `service-worker.js` (e.g. `ptw-v2`).
3. Commit — GitHub Pages republishes automatically in ~1 minute.
