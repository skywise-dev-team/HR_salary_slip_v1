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
# create frontend/.env with: VITE_API_BASE_URL=http://localhost:5000
npm run dev              # http://localhost:5173
```

For production:

```
npm run build            # outputs static files to frontend/dist
```

Serve `frontend/dist` with any static host and point `VITE_API_BASE_URL` at your deployed backend.

## 4. Application modules

**Dashboard** — counts of establishments, active employees, active users, and slips on record
(computed from `salary_data`, not a separately stored count), plus a table of recent pay periods.
This page is view-only in Roles & Permissions — there's nothing on it to grant Edit/Delete access
to.

**Master**
- *Establishments* — company/unit records that print on salary slips (code, name, signatory
  name, address, logo, signature). Uploading a new logo or signature never deletes or overwrites
  the previous file — each upload gets its own unique filename — which is what allows already-
  issued slips to keep showing the correct historical image even after a later change (see
  [Salary slip generation](#8-salary-slip-generation--nothing-is-ever-stored-on-disk)).
- *Employee Master* — fixed details printed on every slip (Employee ID, name, relative's name &
  relation, designation, UAN, bank A/C, establishment, active-from date, Active/Inactive status).
  Changing an employee's establishment automatically logs the change in posting history. An
  employee can optionally be granted their own login (App Access = Yes), with a chosen level of
  Salary Slip access (View & Download / View Only) — logging in with their Employee ID as the
  username, restricted to only their own salary slips. Employee ID Transfer (renaming an existing
  employee's ID in place) and password resets are Admin-only actions that never require approval.

**Upload Salary Data** — one row per employee per pay period; add manually or bulk-import via
Excel. Gross earnings, total deductions, and net pay are computed automatically. Validation on
every add/edit/import:
  - D.A., HRA, and Conveyance Allowance must each be no greater than Basic Pay
  - Total deductions must not exceed gross earnings (net pay can never come out negative)
  - Paid days can't exceed the number of days actually in that period's month (leap years
    handled correctly)
  - Negative figures are allowed (for corrections/adjustments); an all-zero row is allowed too
    (e.g. an employee absent the whole period)

  The summary table groups records by establishment and period; expanding a group lazily loads
  its individual employee rows, with a name/ID search and a Delete action per employee.

**Salary Slips** — every salary record always has an available slip, generated fresh at the
moment it's actually previewed or downloaded. List/filter by establishment, period, or
employee; preview inline; download individually or as a ZIP (grouped into one folder per
establishment inside the archive). A user's `salary_slip_access` setting (View & Download / View
Only / No Access) controls what they can do here, enforced on the backend, not just hidden in the
UI. There is no delete action on this page — removing a salary record (and with it, the ability
to generate its slip at all) is done from Upload Salary Data.

**Change Password** — lets the signed-in user change their own password.

**Admin**
- *Users* — staff accounts (Admin, HR, or any other role). Each Admin-role account can also be
  marked "Can approve" — eligible to be assigned specific approval tasks via Approval Routing
  (see below). The protected `admin` account always has this permanently on.
- *Roles & Permissions* — create roles, select which modules they can access, and a **Manage
  Access** matrix for View/Edit/Delete per module (Dashboard and Activity Log only ever offer
  View, since there's nothing on either to edit or delete). The **Admin** role always has full
  access to every module regardless of what's configured, so you can't lock yourself out.
- *Activity Log* — a filterable audit trail of every staff action (logins, creates, edits,
  deletes, imports, status changes, password resets/changes) — never employee self-service
  logins or activity. Entries older than 6 months are automatically cleaned up daily.
- *Approvals* — see below.
- *Approval Routing* — see below.

## 5. Environment variables

`backend/.env`:

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 5000) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
| `DB_CONNECTION_LIMIT` | Connection pool size (optional; sensible default applied if unset) |
| `JWT_SECRET` | Secret used to sign login tokens — set a long random string |
| `JWT_EXPIRES_IN` | Token lifetime (default `30m`) — every session is force-logged-out at this point, except while a bulk import is actively in progress for that account |
| `CORS_ORIGIN` | Comma-separated list of allowed frontend origins |

`SMTP_*` variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM_NAME`, `SMTP_ALLOW_ARBITRARY_FROM`) are recognized by `backend/src/utils/mailer.js`
but **nothing in the application currently calls it** — every notification (new approval request,
decision on your own request) is in-app only, by design. The mailer exists so email could be
wired back in later without rebuilding it, not because anything sends email today.

`frontend/.env`:

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | The backend's URL, e.g. `http://localhost:5000` |

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
accounts). Every session is force-logged-out after `JWT_EXPIRES_IN` (default 30 minutes) — except
that a bulk Excel import already in progress for that account defers the logout until the import
finishes, rather than interrupting it.

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

A slip's PDF is built fresh, in memory, at the exact moment someone previews or downloads it —
individually, or one at a time while a bulk ZIP is being assembled — and is never written to disk
or cached anywhere. There is no "missing slip," no regeneration step, and no retention/cleanup job
for slip files, because there's nothing ever sitting on disk to go missing or need cleaning up.

**Historical accuracy is guaranteed by a snapshot taken once, at the moment a salary record is
first created** (single add or bulk import) — freezing the employee's full name, relative's
name/relation, designation, UAN, and bank account number, and the establishment's name, address,
signatory name, and which logo/signature file was current, all at that exact moment. Editing that
record's figures later, or re-importing it, never touches this snapshot. A later change to the
employee's designation or the establishment's signature therefore has **no effect whatsoever** on
any slip already covering an earlier period — a June slip permanently shows June's data, even if
everything about that employee or establishment changes in August.

The PDF itself follows the statutory **Form-XVI** wage slip layout (Occupational Safety, Health
and Working Conditions Code, 2020), laid out on **A4 portrait** paper with two slips stacked per
sheet (cut in half for two complete copies with no wasted paper — a single download simply leaves
the second half blank), using **Carlito** (the free, metrically-compatible equivalent of Calibri)
via `backend/src/assets/fonts/Carlito-*.ttf`, bundled with the project. Net pay is spelled out in
words using the Indian numbering system (Lakh/Crore). **Date of issue** is always the 7th of the
month immediately following the pay period (e.g. a January 2026 slip always shows 07-02-2026),
regardless of when it's actually generated or regenerated — a fixed business date, not a
processing timestamp.

Downloads (single or via ZIP) are named `{Employee Name}_{Employee ID}_{Month-Year}.pdf`; a bulk
ZIP groups files into one folder per establishment.
