# Salary Slip Register — Full Stack Application

React (Vite) frontend + Node.js/Express backend + MySQL database.

```
salary-slip-system/
├── backend/     Node.js + Express API, MySQL access, on-demand PDF generation, Excel import/export
└── frontend/    React (Vite) single-page app
```

## 1. Database setup

1. Make sure MySQL is running and you have a user with permission to create databases.
2. Create `backend/.env` (see [Environment variables](#5-environment-variables) below).
3. Install dependencies and apply the schema:

   ```
   cd backend
   npm install
   npm run migrate     # creates the `salary_slip` database and every table, from schema.sql
   npm run seed         # creates the default admin login
   ```

   `schema.sql` is the single source of truth for the database structure — it's a complete,
   current snapshot, not a series of incremental changes. You do not need to run anything else
   for a fresh install.

   Default login after seeding: **user_id `admin`**, **password `Admin@123`**.
   Change this password immediately after first login (Change Password page). This account is
   permanently protected — it can never be deleted or deactivated, and it always retains full
   Admin access and approval authority (see [Approvals](#7-approval-workflow) below).

## 2. Backend

```
cd backend
npm install
npm run dev      # nodemon, http://localhost:5000
# or
npm start        # plain node
```

Uploaded files (establishment logos and signatures, and Excel files staged for approval) are
stored under `backend/uploads/`. Back this folder up, or point it at persistent storage, when
you deploy. **Salary slip PDFs are never stored here or anywhere else** — see
[Salary slip generation](#8-salary-slip-generation--nothing-is-ever-stored-on-disk).

## 3. Frontend

```
cd frontend
npm install
# optional: frontend/.env with VITE_API_BASE_URL=... (if omitted, see the note below)
npm run dev              # http://localhost:5173
```

For production:

```
npm run build            # outputs static files to frontend/dist
```

Serve `frontend/dist` with any static host. **Leave `VITE_API_BASE_URL` unset or empty for production** —
the app then calls the API on the same host the page was opened from (port 5000), so the one build
works for everybody: people who open it at the server's LAN address use the API over the LAN, and
people who open it at the public address use it there. This also keeps office staff traffic on the
LAN, so the server sees their real office addresses for the staff network restriction (see
[Restricting staff to the office network](#restricting-staff-to-the-office-network)). Only set
`VITE_API_BASE_URL` if the API runs on a different port or a different host than the page.

## 4. Application modules

The left menu is a slim icon rail that opens when you hover over it. The signed-in user name and
icon sit at the top right; clicking it opens **Change password** and **Sign out**. The same layout
is used for employee logins.

**Dashboard** — live counters and charts, refreshed automatically every 60 seconds and always
computed from the database, so they grow and resize as slips and employees are added:
Active Employees by Establishment, Slips per Pay Period, Active Users by Role and Employee Status,
with the totals shown under each chart title. View-only in Roles & Permissions.

**Master**
- *Establishments* — company/unit records that print on salary slips (code, name, signatory
  name, address, logo, signature). Changes to the printed details take an **Effective from** date.
  Uploading a new logo or signature never deletes or overwrites the previous file.
- *Employee Master* — details printed on every slip (Employee ID, name, relative's name &
  relation, designation, UAN, bank A/C, establishment, Active from) plus an optional email.
  - **Add**: there is no Effective-from field; a new employee's details are effective from the
    Active-from date.
  - **Edit**: Effective from appears here. The form opens with the Effective-from date of the
    last saved change. Status (Active / Inactive) is changed here only: going Inactive asks for the
    Inactive date, and making an employee Active again asks for a new Active-from date.
  - **App Access** is a toggle in the list column, for one employee or for a selection (bulk bar:
    "App access: Yes / No"). Turning it on creates the employee login (the Employee ID is the
    first password) with Salary slip access **View only**; the access level is then changed in
    Edit. An Inactive employee cannot have app access.
  - Search, establishment and status filters. Ticks are kept by employee across searches,
    filters and pages; the header tick acts on the rows currently shown.
  - **History** shows every change with its effective date; **Export** downloads the employee
    details and the change history as Excel; Bulk import from Excel has a downloadable template.
  - Employee ID Transfer and password resets are Admin-only and never need approval.

**Upload Salary Data**
- *Monthly salary data* and *Arrear salary data* tabs — add one record, edit, delete, or bulk
  import from Excel (template provided). Arrear records can also be exported to Excel. Both tabs
  have search, selection kept across pages, and pagination.
- Gross earnings, total deductions and net pay are computed automatically.
- The checks are listed in [Business rules](#9-business-rules).

**Salary Slips** — Monthly and Arrear tabs. Every record has a slip that is generated at the
moment it is previewed or downloaded.
- With **All establishments** and **All months** selected (admin / HR views) the list is grouped:
  Establishment → Employee → that employee's slips (latest first). Groups open collapsed; click to
  expand. Every establishment is listed on the page and each one is paginated on its own. The
  establishment and employee ticks select all of their slips (also across pages).
- Choosing a specific establishment or month shows the plain list.
- Preview inline, download one slip, or download a ZIP grouped into one folder per establishment.
  What a user can do is controlled by their Salary slip access (View & Download / View only / No
  access), enforced on the backend.

**Change Password** — the signed-in user changes their own password.

**Admin**
- *Users* — staff accounts. Search by User ID / email and multi-select filters for **Role** and
  **Establishment** (a user with all-establishment access, including Admin, always matches an
  establishment filter). Email is optional. Each Admin-role account can be marked "Can approve".
- *Roles & Permissions* — create roles, choose their modules, and set View / Edit / Delete per
  module. The **Admin** role always has full access.
- *Activity Log* — filterable audit trail of staff actions; entries older than 6 months are
  cleaned up daily.
- *Approvals* — see section 7. Search the inbox by the user who requested.
- *Approval Routing* — see section 7.

## 5. Environment variables

`backend/.env`:

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 5000) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
| `DB_CONNECTION_LIMIT` | Connection pool size (optional; sensible default applied if unset) |
| `JWT_SECRET` | Secret used to sign login tokens — set a long random string |
| `JWT_EXPIRES_IN` | Maximum session length (default `90m`). Set `JWT_EXPIRES_IN=90m` in `.env` — a value already in `.env` overrides the default. Every session is signed out at this point, except while a bulk import is running. Separately, the app signs a user out after **5 minutes without activity** (fixed in `frontend/src/context/AuthContext.jsx`) |
| `CORS_ORIGIN` | Comma-separated list of allowed frontend origins |
| `ALLOWED_STAFF_IPS` | Restricts **staff** accounts to the company network — see [Restricting staff to the office network](#restricting-staff-to-the-office-network). Unset = no restriction |
| `TRUST_PROXY` | Number of reverse proxies in front of the API (e.g. `1` for nginx). Leave unset if visitors connect directly. Needed for the network restriction to see real visitor addresses behind a proxy |

`SMTP_*` variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM_NAME`, `SMTP_ALLOW_ARBITRARY_FROM`) are recognized by `backend/src/utils/mailer.js`
but **nothing in the application currently calls it** — every notification (new approval request,
decision on your own request) is in-app only, by design. The mailer exists so email could be
wired back in later without rebuilding it, not because anything sends email today.

`frontend/.env`:

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Optional. Pins the backend's URL (e.g. `http://localhost:5000`). If unset or empty, the app uses the same host the page was loaded from, on port 5000 |

## 6. Login system

A single login form serves two different kinds of account:
- **Staff accounts** (Users page) — Admin, HR, or any other role, authenticated by `user_id`.
- **Employee self-service accounts** — an Employee Master record with App Access = Yes,
  authenticated by Employee ID.

**The same ID can legitimately belong to both at once** (e.g. an HR staff member who is also paid
through the system as an employee). If so, login always asks explicitly which account is meant —
never guesses from the password, since a freshly-provisioned account on either side defaults its
password to the ID itself and the two could easily be identical.

Login is **case-sensitive** for both User ID and Employee ID (`HR1` and `hr1` are different
accounts). A session ends after 5 minutes with no mouse, keyboard, scroll or touch activity, and in any case
after `JWT_EXPIRES_IN` (default 90 minutes). The last-activity time is shared between browser tabs,
so a tab reopened after being away longer than that is signed out. A bulk Excel import in
progress defers the sign-out until it finishes.

### Restricting staff to the office network

Staff accounts (the Users page — Admin, HR, and every other role) can be limited to the company
network. **Employee self-service logins are never restricted** — an employee can still reach their
own salary slips from anywhere.

Set `ALLOWED_STAFF_IPS` in `backend/.env` to a comma-separated list of any mix of:

```
ALLOWED_STAFF_IPS=203.0.113.10                        # a single address
ALLOWED_STAFF_IPS=192.168.1.0/24                      # a CIDR range
ALLOWED_STAFF_IPS=10.0.0.5-10.0.0.50                  # an inclusive range
ALLOWED_STAFF_IPS=203.0.113.10,192.168.1.0/24         # any combination (IPv6 works too)
```

Unset or empty means **no restriction**. Once set, a staff account is refused from every address not
on the list — at login, and again on **every request** afterwards, so a session started in the office
can't be carried home and kept using. The server prints `Staff network restriction: ON/OFF` at startup.

What to put in the list depends on where the server runs:

- **Server inside the office LAN, reached directly** — list the office's private range, e.g.
  `192.168.1.0/24` (check with `ipconfig` on an office PC). Leave `TRUST_PROXY` unset.
- **Server on the office LAN that also has its own public address (for employees outside)** —
  list only the office's private range, and have staff open the app at the server's **LAN**
  address. Do **not** list the server's own public address: it identifies the server, not the
  office. If staff will ever open the app through the public address from inside the office,
  their traffic arrives from the office's *outgoing* public IP instead (search "what is my IP"
  from an office PC — it is usually a different address from the server's) and that one would
  need adding.
- **Server hosted elsewhere (cloud/VPS), reached over the internet** — list the office's **public**
  IP (search "what is my IP" from an office PC). This must be a *static* IP: if your ISP changes it,
  every staff login is locked out until the list is updated and the server restarted. If the API
  sits behind nginx or similar, also set `TRUST_PROXY=1` — without it every visitor appears to come
  from the proxy's own address.
- **Local development** — either leave `ALLOWED_STAFF_IPS` unset, or include `127.0.0.1,::1`.
  Loopback is deliberately never allowed automatically (behind a proxy on the same machine, that
  would let everyone in).

Good to know:
- It restricts by **network address**, so it can't tell devices or people on the same network apart.
  Anyone whose traffic leaves through the office address is allowed — including guests on a shared
  Wi-Fi and anyone connected to the office VPN.
- The **Super Admin account is restricted too** (no exemptions). If the list is ever wrong, fix
  `ALLOWED_STAFF_IPS` in `backend/.env` and restart the server.
- A refused staff user sees their current address in the message, which makes a wrong list or a
  missing `TRUST_PROXY` easy to spot. The message only appears after a correct password, so an
  outsider guessing passwords learns nothing about which accounts exist.
- Entries that can't be parsed are skipped with a startup warning — that only ever makes the
  restriction stricter. If *every* entry is invalid, the restriction stays on and nobody gets in.

## 7. Approval workflow

Certain actions by non-Admin staff are staged for approval instead of applied immediately:
single and bulk create/edit/delete/status-change, and bulk Excel import, across **Employee
Master, Users, and Upload Salary Data**. An Admin performing the same action applies it
immediately, same as always. Employee ID Transfer, password resets, and slip regeneration are
never staged — they're not real payroll data changes.

- The requester sees "Submitted for approval, pending" instead of a normal success message.
- A bulk import is validated immediately (a bad file is rejected outright, before it ever reaches
  an Admin); only a file that already passes validation is held for approval, unprocessed, until
  a decision is made.
- Approving actually performs the original action at that moment; rejecting requires a reason,
  which is shown to the original requester.
- A request left untouched for 7 days automatically expires, notifying the requester.
- Both the new-request notification (to whoever can approve it) and the decision notification
  (back to the requester) are in-app only — a bell icon with a live-updating unread count.

**Approval Routing** (Super Admin only) lets specific tasks be restricted to one or more named,
"Can approve"-eligible Admins — fully hidden from every other Admin, not just unactionable to
them. Anything not covered by a rule (or a rule whose named approvers have all since become
ineligible) always falls back to the Super Admin specifically, never to "every Admin" — every
request always has a well-defined, specific owner. Any change to the Users module is always
routed to the Super Admin only, permanently, and can't be reassigned through the routing rules
screen. The Super Admin account is a permanent overseer on top of all of this — it can see and
act on every request regardless of how it's routed.

## 8. Salary slip generation — nothing is ever stored on disk

A slip's PDF is built fresh, in memory, at the moment someone previews or downloads it —
individually, or one at a time while a ZIP is assembled — and is never written to disk. There is
no "missing slip", regeneration step or cleanup job.

**Which employee / establishment details a slip shows** comes from the effective-dated history in
`employee_versions` and `establishment_versions`. Every save with an Effective-from date is kept
exactly as saved (nothing older is edited). To build a slip, of the versions whose effective date
is on or before the slip's date, the one **saved most recently** is used, so the latest change
always wins:
- **Monthly slip** — the slip's date is the last day of the pay month. A change effective 05-08
  is not on the July slip and is on the August slip.
- **Arrear slip** — the slip's date is its **date of issue**; the arrear period does not matter.

Changing details or an Effective-from date therefore shows on the very next preview / download.

The PDF follows the statutory **Form-XVI** wage slip layout (Occupational Safety, Health and
Working Conditions Code, 2020) on **A4 portrait**. Two slips in one download are stacked on one
sheet (cut in half for two copies); a single slip ends right after its "Computer-generated" line,
with no blank half-page. Font: **Carlito** (`backend/src/assets/fonts/`). Net pay is written in
words with the Indian system (Thousand / Lakh / Crore, including amounts of 100 crore and above).

**Date of issue** — monthly slip: the 7th of the month after the pay month. Arrear slip: the date
entered with the record. Arrear slips are titled "ARREAR WAGE / SALARY SLIP" and show their period.

Downloads are named `{Employee Name}_{Employee ID}_{Month-Year}.pdf`; a ZIP groups files into one
folder per establishment.

## 9. Business rules

**Dates**
- No date may be before the employee's **Active from** date: effective-from, inactive date, date
  of issue, and every salary / arrear month.
- No date may be **after today**, and no pay or arrear month after the current month: Active from,
  Inactive date, Effective from (employees and establishments) and an arrear's Date of issue. The
  date pickers stop at today and the server enforces it, including for Excel uploads.
- **Active from** cannot be moved later than any salary month, arrear period, arrear date of
  issue or effective-from already saved for that employee; the same applies when an employee is
  made Active again.
- Salary and arrear months must fall inside the employee's active window (from the Active-from
  month to the Inactive month).
- An arrear's **Date of issue** must be after the arrear "to" month (on or after the 1st of the
  following month).

**Salary figures** (add, edit and import)
- If Paid days is greater than 0, Basic must be greater than 0.
- D.A., HRA and Conveyance Allowance must each be no greater than Basic.
- Total deductions cannot exceed gross earnings (net pay is never negative).
- Paid days cannot exceed the days in that month. Negative adjustment figures are allowed.

**Employees**
- Email is optional. App access needs the employee to be Active.
- Re-activating requires a new Active-from date.

## 10. Final changes in this release

- **Slip details**: slips use the latest saved effective-dated change (monthly by pay month, arrear
  by date of issue); older versions are never edited. Slips update immediately after a change.
- **Employee Master**: App Access toggle (single and bulk) replaces the Status toggle; Active /
  Inactive, inactive date, re-activation and Effective from are handled in Edit; Effective from
  opens with the last saved date; no Effective-from field when adding.
- **Dates**: not before Active from, not after today (see section 9); arrear date of issue must
  follow the arrear period.
- **Salary upload**: Basic must be above 0 when Paid days is above 0; arrear Excel export; the
  same search, multi-select (kept across pages) and pagination on both tabs.
- **Salary Slips**: Establishment → Employee → slips grouped view with per-establishment
  pagination, collapsed by default (monthly and arrear); single-slip PDF has no blank half-page;
  amount-in-words fixed for very large amounts.
- **Users**: Role and Establishment multi-select filters; email optional.
- **Approvals**: search by requested-by user; App-access changes follow the Edit routing rule.
- **Dashboard**: new charts, totals under chart titles, 60-second refresh; larger axis labels.
- **Layout**: hover-expand icon sidebar, user menu with Change password / Sign out at the top
  right, a receipt-style icon for Salary Slips, and the word "staff" shown as "HR" in the UI.
- **Sessions**: 5-minute inactivity sign-out; maximum session 90 minutes.

## 11. Project layout

```
backend/
  src/server.js            Express app, cron jobs (retention cleanup, approval expiry)
  src/config/              db.js, schema.sql (complete schema), migration_*.sql, seed.js, migrate.js
  src/routes/              auth, users, roles, employees, establishments, salaryData, arrearData,
                           salarySlips, approvals, approvalRouting, dashboard, activityLog
  src/utils/               employmentWindow.js (date rules), effectiveDating.js (versions),
                           slipService.js + pdfGenerator.js (slips), approvalRouting.js, figureCheck.js
  src/assets/fonts/        Carlito fonts used on slips
  uploads/                 logos, signatures and staged Excel imports (not committed)
frontend/
  src/pages/               one file per screen
  src/components/          shared pieces (Layout, Sidebar, UserMenu, pickers, ArrearUpload, ArrearSlips)
  src/context/AuthContext  login state, 5-minute inactivity sign-out
  src/styles/app.css       all styling
```
