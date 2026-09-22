-- =========================================================
-- Salary Slip System — MySQL schema
-- (reordered + small fixes from the original hr_schema.sql so that
--  foreign keys resolve. Manage Access uses a View/Edit/Delete
--  matrix — no separate Create permission.)
-- =========================================================

CREATE DATABASE IF NOT EXISTS salary_slip;
USE salary_slip;

SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------
-- ADMIN > Roles
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  role_name    VARCHAR(40) NOT NULL UNIQUE,
  description  VARCHAR(120),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- modules selected while creating a role ("Select Module name" multi-select),
-- together with the manage-access checkboxes (View / Edit / Delete) for each
-- one — merged into a single table since a module is never assigned to a
-- role without also having a view/edit/delete row, and vice versa.
CREATE TABLE IF NOT EXISTS role_modules (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  role_id      INT NOT NULL,
  module_key   VARCHAR(40) NOT NULL,   -- 'dashboard','establishments','employees','upload_salary','salary_slips','users','roles_permissions','activity_log'
  can_view     TINYINT(1) NOT NULL DEFAULT 0,
  can_edit     TINYINT(1) NOT NULL DEFAULT 0,
  can_delete   TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_rm_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  UNIQUE KEY uq_role_module (role_id, module_key)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- ADMIN > Users
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             VARCHAR(60) NOT NULL UNIQUE,   -- login id, alphanumeric
  password_hash       VARCHAR(255) NOT NULL,
  email               VARCHAR(150),
  role_id             INT NOT NULL,
  status              ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  -- Whether this account can be assigned as an approval-routing approver
  -- (see approval_routing_rules below). Only meaningful for Admin-role
  -- accounts; always true, unchangeably, for the one protected admin
  -- account (enforced in code, not here).
  can_approve         TINYINT(1) NOT NULL DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- Activity log — staff accounts only (Admin, HR, Super Admin, or any other
-- account managed via the Users page). Employee Master logins are never
-- logged here: they can only ever view their own salary slip, so there is
-- nothing meaningful to audit for them. Only records actions that actually
-- change something (create/update/delete/import/status change/password
-- reset/login) — not page views, previews, or downloads.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT DEFAULT NULL,          -- FK to users.id; NULL-able so deleting an account never deletes its history
  performed_by VARCHAR(60) NOT NULL,      -- snapshot of their login ID at the time — stays readable even after the account is deleted
  role_name    VARCHAR(40) NOT NULL,      -- snapshot of their role at the time
  action       VARCHAR(20) NOT NULL,      -- LOGIN, CREATE, UPDATE, DELETE, IMPORT, STATUS_CHANGE, PASSWORD_RESET, PASSWORD_CHANGE
  module_key   VARCHAR(40) DEFAULT NULL,  -- employees, users, establishments, upload_salary, salary_slips, roles_permissions — NULL for LOGIN/PASSWORD_CHANGE
  description  VARCHAR(255) NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_activity_log_user (user_id),
  KEY idx_activity_log_created (created_at),
  CONSTRAINT fk_activity_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- Approval workflow — non-Admin staff actions in Employee Master, Users,
-- and Upload Salary Data (single create/edit/delete, every bulk action,
-- and the Excel import for each) are held here pending an Admin's decision
-- rather than applied immediately. Admin-performed actions bypass this
-- entirely and apply right away, same as before this feature existed.
-- Employee ID transfers, password resets, and slip regeneration are never
-- routed through here.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_requests (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  module_key          VARCHAR(40) NOT NULL,        -- employees, users, upload_salary
  action              VARCHAR(20) NOT NULL,        -- CREATE, UPDATE, DELETE, IMPORT
  requested_by        INT DEFAULT NULL,            -- FK to users.id; NULL-able so deleting an account never deletes request history
  requested_by_name   VARCHAR(60) NOT NULL,        -- snapshot of their login ID at the time
  requested_by_email  VARCHAR(150),                -- snapshot of their email at the time — the approval email is sent FROM this address
  target_id           INT DEFAULT NULL,            -- the record being edited/deleted (employees.id, users.id, or salary_data.id) — NULL for a CREATE or IMPORT
  payload             JSON,                        -- the submitted form data to apply on approval — NULL for IMPORT (uses staged_file_path instead) and for a plain DELETE
  staged_file_path    VARCHAR(255),                -- IMPORT only: the already-validated Excel file, held until approved/rejected/expired
  description         VARCHAR(255) NOT NULL,       -- human summary shown in the Approvals inbox, e.g. "Edit employee EMP001234" or "Bulk import 250 employee(s)"
  status              ENUM('PENDING','APPROVED','REJECTED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  rejection_reason    VARCHAR(500),
  decided_by          INT DEFAULT NULL,
  decided_by_name     VARCHAR(60),
  decided_at          TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at          TIMESTAMP NOT NULL,          -- created_at + 7 days, set at insert time
  -- Which specific accounts this request is restricted to — always a JSON
  -- array of user ids, resolved once at creation time by whichever routing
  -- rule matched then, or the Super Admin alone if none did. Every request
  -- always has a specific owner; none default to "every Admin". Re-checked
  -- live against current account status/eligibility whenever the request
  -- is actually viewed, rather than trusted as still valid — see
  -- utils/approvalRouting.js. NULL only ever appears on a request created
  -- before this behavior existed, and is still treated as "visible to
  -- every Admin" for that older data, never assigned to a new request.
  visible_to          JSON DEFAULT NULL,
  KEY idx_approval_status (status),
  KEY idx_approval_requested_by (requested_by),
  CONSTRAINT fk_approval_requested_by FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_approval_decided_by FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- In-app notifications, both directions: an Admin gets one when a new
-- request needs their attention, and the original requester gets one when
-- their request is approved, rejected (with the reason), or expires.
CREATE TABLE IF NOT EXISTS notifications (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  approval_id   INT DEFAULT NULL,
  message       VARCHAR(500) NOT NULL,
  is_read       TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user (user_id, is_read),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_approval FOREIGN KEY (approval_id) REFERENCES approval_requests(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- Approval routing — lets specific approval-worthy tasks be restricted to
-- one or a few named Admins instead of every Admin, and fully hidden from
-- everyone else (see approval_requests.visible_to above, which records
-- which accounts a given request was actually routed to). A rule can
-- target a specific module, a specific action, both together, or neither
-- (module_key/action left NULL matches "any"). Its approver(s) are stored
-- directly as a JSON array of user ids, rather than a separate join
-- table, since a rule only ever needs its own small list read as a whole,
-- never queried or joined from the other direction.
-- Users -> Any action is a hard-coded, permanent exception handled in code
-- (utils/approvalRouting.js), not stored as a row here — it can never be
-- edited or removed through this table.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_routing_rules (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  module_key    VARCHAR(40) DEFAULT NULL,   -- NULL = any module
  action        VARCHAR(20) DEFAULT NULL,   -- NULL = any action
  approver_ids  JSON NOT NULL,              -- array of users.id
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- MASTER > Establishments
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS establishments (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  est_code        VARCHAR(40)  NOT NULL UNIQUE,
  name            VARCHAR(100) NOT NULL,
  signatory_name  VARCHAR(100),
  address         VARCHAR(255),
  logo_path       VARCHAR(255),
  signature_path  VARCHAR(255),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- MASTER > Employee Master
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  employee_id           VARCHAR(40) NOT NULL UNIQUE,
  full_name             VARCHAR(100) NOT NULL,
  relative_name         VARCHAR(100),                  -- father's/mother's/spouse's name
  relation              VARCHAR(20),
  designation           VARCHAR(60),
  uan                   VARCHAR(15),
  bank_account_no       VARCHAR(30),
  establishment_id      INT NOT NULL,
  active_from           DATE,
  status                ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  -- App login fields, added for Employee Master-provisioned logins: an
  -- employee's own app access now lives directly on this table instead of
  -- a separate users row. app_access is kept in sync with `status` by the
  -- quick Active/Inactive toggle (Active -> YES, Inactive -> NO), but can
  -- also be set independently via the Add/Edit form and bulk import.
  email                 VARCHAR(150) DEFAULT NULL,
  password_hash         VARCHAR(255) DEFAULT NULL,
  app_access            ENUM('YES','NO') NOT NULL DEFAULT 'NO',
  salary_slip_access    ENUM('VIEW_DOWNLOAD','VIEW_ONLY','NO_ACCESS') NOT NULL DEFAULT 'VIEW_ONLY',
  must_change_password  TINYINT(1) NOT NULL DEFAULT 1,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_emp_est FOREIGN KEY (establishment_id) REFERENCES establishments(id)
) ENGINE=InnoDB;

-- posting history (kept whenever an employee's establishment changes).
CREATE TABLE IF NOT EXISTS employee_post_hist (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  employee_id           INT NOT NULL,
  establishment_id      INT NOT NULL,
  active_from           DATE,
  active_to             DATE,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hist_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_hist_est FOREIGN KEY (establishment_id) REFERENCES establishments(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- Upload Salary Data  (one row per employee per pay period)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS salary_data (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  establishment_id  INT NOT NULL,
  employee_id       INT NOT NULL,
  period_month      TINYINT NOT NULL,   -- 1-12
  period_year       SMALLINT NOT NULL,
  paid_days         DECIMAL(4,2) DEFAULT 0,
  basic             DECIMAL(12,2) DEFAULT 0,
  hra               DECIMAL(12,2) DEFAULT 0,
  da                DECIMAL(12,2) DEFAULT 0,   -- renamed from other_allowance
  conveyance_allowance DECIMAL(12,2) DEFAULT 0,
  overtime          DECIMAL(12,2) DEFAULT 0,
  gross_earnings    DECIMAL(12,2) DEFAULT 0,
  pf_deduction      DECIMAL(12,2) DEFAULT 0,
  esi_deduction     DECIMAL(12,2) DEFAULT 0,
  pt_deduction      DECIMAL(12,2) DEFAULT 0,   -- displayed as "P-Tax"
  tds_deduction     DECIMAL(12,2) DEFAULT 0,
  other_deduction   DECIMAL(12,2) DEFAULT 0,
  total_deduction   DECIMAL(12,2) DEFAULT 0,
  net_pay           DECIMAL(12,2) DEFAULT 0,
  -- Backend-only tracking column, never exposed via the app's API responses
  -- or shown anywhere in the frontend. Set to 1 the moment the EMPLOYEE
  -- themselves (not an Admin/HR download on their behalf) downloads their
  -- own slip for this period, and reset to 0 automatically whenever this
  -- row's own figures are edited or re-imported — since a slip already
  -- downloaded no longer reflects updated numbers until downloaded again.
  -- Once set to 1, downloading again any further number of times leaves it
  -- at 1 (this is a flag, not a counter).
  downloaded        TINYINT(1) NOT NULL DEFAULT 0,
  -- Captured exactly once, at the moment this row is first created (single
  -- add or bulk import) — never touched again, even if this row's own
  -- figures are later edited or re-imported. Freezes everything about the
  -- employee and establishment that could change *after* this point but
  -- must never retroactively alter an already-issued slip: full_name,
  -- relative_name, relation, designation, uan, bank_account_no (employee),
  -- and establishment_name, address, signatory_name, logo_path,
  -- signature_path (establishment) — the exact logo_path/signature_path
  -- string as it was that day, which still resolves correctly even after
  -- a later logo/signature change, since a new upload never overwrites or
  -- deletes the previous file (each upload gets its own unique filename).
  -- The slip PDF itself is generated fresh, on demand, from this snapshot
  -- every time it's previewed or downloaded — never stored on disk.
  slip_snapshot     JSON DEFAULT NULL,
  uploaded_by       INT,                -- users.id
  uploaded_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sd_est  FOREIGN KEY (establishment_id) REFERENCES establishments(id),
  CONSTRAINT fk_sd_emp  FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_sd_user FOREIGN KEY (uploaded_by) REFERENCES users(id),
  UNIQUE KEY uq_est_period_emp (establishment_id, period_month, period_year, employee_id)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------
-- Seed: Admin role with full access to every module
-- ---------------------------------------------------------
INSERT INTO roles (role_name, description)
  SELECT 'Admin', 'Full system access'
  WHERE NOT EXISTS (SELECT 1 FROM roles WHERE role_name = 'Admin');

INSERT IGNORE INTO role_modules (role_id, module_key, can_view, can_edit, can_delete)
SELECT r.id, m.module_key, 1, 1, 1 FROM roles r
JOIN (
  SELECT 'dashboard' module_key UNION ALL SELECT 'establishments' UNION ALL
  SELECT 'employees' UNION ALL SELECT 'upload_salary' UNION ALL
  SELECT 'salary_slips' UNION ALL SELECT 'users' UNION ALL SELECT 'roles_permissions' UNION ALL
  SELECT 'activity_log'
) m ON r.role_name = 'Admin';

-- Default admin user is NOT inserted here because the password must be bcrypt-hashed.
-- After creating the database and setting backend/.env, run:   npm run seed
-- from /backend — it creates user_id "admin" / password "Admin@123" (role: Admin).

-- ---------------------------------------------------------
-- If you already ran an earlier version of this schema where role_modules
-- and role_permissions were two separate tables, merge them into the single
-- role_modules table above with:
--   backend/src/config/migration_merge_role_modules_permissions.sql
-- (CREATE TABLE IF NOT EXISTS above will not alter or merge existing tables.)
-- ---------------------------------------------------------

-- ---------------------------------------------------------
-- If you already ran an earlier version of this schema without
-- users.must_change_password, add it with:
--   ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0;
-- ---------------------------------------------------------

-- ---------------------------------------------------------
-- If you already ran an earlier version of this schema where salary_data
-- had other_allowance instead of da, and no conveyance_allowance / overtime /
-- tds_deduction columns, bring an existing database up to date with:
--   ALTER TABLE salary_data CHANGE other_allowance da DECIMAL(12,2) DEFAULT 0;
--   ALTER TABLE salary_data ADD COLUMN conveyance_allowance DECIMAL(12,2) DEFAULT 0 AFTER da;
--   ALTER TABLE salary_data ADD COLUMN overtime DECIMAL(12,2) DEFAULT 0 AFTER conveyance_allowance;
--   ALTER TABLE salary_data ADD COLUMN tds_deduction DECIMAL(12,2) DEFAULT 0 AFTER pt_deduction;
-- ---------------------------------------------------------

-- ---------------------------------------------------------
-- If you already ran an earlier version of this schema where deleting an
-- employee also deleted their posting history (ON DELETE CASCADE), bring it
-- up to date so history survives deletion, with identity fields snapshotted
-- directly onto each history row:
--   ALTER TABLE employee_post_hist
--     ADD COLUMN employee_code   VARCHAR(40)  AFTER employee_id,
--     ADD COLUMN full_name       VARCHAR(100) AFTER employee_code,
--     ADD COLUMN relative_name   VARCHAR(100) AFTER full_name,
--     ADD COLUMN relation        VARCHAR(20)  AFTER relative_name,
--     ADD COLUMN designation     VARCHAR(60)  AFTER relation,
--     ADD COLUMN uan             VARCHAR(15)  AFTER designation,
--     ADD COLUMN bank_account_no VARCHAR(30)  AFTER uan;
--   ALTER TABLE employee_post_hist DROP FOREIGN KEY fk_hist_emp;
--   ALTER TABLE employee_post_hist MODIFY employee_id INT NULL;
--   ALTER TABLE employee_post_hist
--     ADD CONSTRAINT fk_hist_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;
--   -- Backfill the new columns for existing history rows from the current
--   -- employee records (any employees already deleted before this migration
--   -- will keep NULL identity fields for their old rows — there is no way to
--   -- recover data that was already cascade-deleted):
--   UPDATE employee_post_hist h
--     JOIN employees e ON e.id = h.employee_id
--     SET h.employee_code = e.employee_id, h.full_name = e.full_name,
--         h.relative_name = e.relative_name, h.relation = e.relation,
--         h.designation = e.designation, h.uan = e.uan, h.bank_account_no = e.bank_account_no
--     WHERE h.employee_code IS NULL;
-- ---------------------------------------------------------
