import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import {
  initializeWorkflows,
  loadWorkflow,
  saveWorkflow,
} from "./workflows.js";
import { normalizeAppointmentStatuses } from "./workflow-engine.js";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** SQLite cannot alter CHECK constraints; rebuild only this table, retaining its complete schema and indexes. */
function migrateNoShowStatus(db: DatabaseSync) {
  const original = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='appointments'",
    )
    .get() as { sql: string };
  const statusConstraint = original.sql.match(
    /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
  );
  if (statusConstraint?.[1].includes("'No-show'")) return;
  const widened = original.sql.replace(
    /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
    (_match, statuses: string) => `CHECK(status IN (${statuses},'No-show'))`,
  );
  if (widened === original.sql)
    throw new Error("Cannot migrate the appointment status constraint");
  const replacement = widened.replace(
    /^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"appointments"|`appointments`|\[appointments\]|appointments)(?=\s*\()/i,
    '$1"appointments_no_show_migration"',
  );
  if (replacement === widened)
    throw new Error("Cannot migrate the appointment table definition");
  const columns = (
    db.prepare("PRAGMA table_info(appointments)").all() as { name: string }[]
  )
    .map((column) => identifier(column.name))
    .join(",");
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE tbl_name='appointments' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all() as { sql: string }[];
  const legacyAlterTable = (
    db.prepare("PRAGMA legacy_alter_table").get() as {
      legacy_alter_table: number;
    }
  ).legacy_alter_table;
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(replacement);
    db.exec(
      `INSERT INTO appointments_no_show_migration (${columns}) SELECT ${columns} FROM appointments`,
    );
    db.exec("DROP TABLE appointments");
    db.exec(
      "ALTER TABLE appointments_no_show_migration RENAME TO appointments",
    );
    for (const entry of schema) db.exec(entry.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Appointment migration failed foreign key validation");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(
      `PRAGMA legacy_alter_table=${legacyAlterTable ? "ON" : "OFF"}; PRAGMA foreign_keys=ON`,
    );
  }
}

/** Preserve recorded queue history while making legacy no-shows visible to all SQL appointment reads. */
export function synchronizeNoShowStatuses(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = loadWorkflow(db),
      appointments = db.prepare("SELECT * FROM appointments").all() as Record<
        string,
        any
      >[];
    const before = new Map(appointments.map((a) => [a.id, a.status]));
    if (normalizeAppointmentStatuses(state, appointments)) {
      const update = db.prepare("UPDATE appointments SET status=? WHERE id=?");
      for (const a of appointments)
        if (a.status !== before.get(a.id)) update.run(a.status, a.id);
      saveWorkflow(db, state);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function clinicDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

export function hashPassword(
  password: string,
  salt = randomBytes(16).toString("hex"),
) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function createDatabase(
  filename: string,
  options: { seedDemo?: boolean } = {},
) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('clinician','receptionist'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, dob TEXT NOT NULL,
      sex TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '', allergies TEXT NOT NULL DEFAULT '[]',
      address_unit TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '', zip_code TEXT NOT NULL DEFAULT '',
      conditions TEXT NOT NULL DEFAULT '[]', medications TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
      date TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 30,
      type TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Scheduled' CHECK(status IN ('Scheduled','Checked in','In progress','Completed','Cancelled','No-show')),
      provider_id TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS encounters (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
      appointment_id TEXT UNIQUE REFERENCES appointments(id), author_id TEXT NOT NULL REFERENCES users(id),
      chief_complaint TEXT NOT NULL, subjective TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT '', assessment TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '',
      bp TEXT NOT NULL DEFAULT '', pulse TEXT NOT NULL DEFAULT '', temperature TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Signed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), signed_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, patient_id TEXT REFERENCES patients(id), title TEXT NOT NULL,
      category TEXT NOT NULL, priority TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS labs (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), name TEXT NOT NULL,
      value TEXT NOT NULL, unit TEXT NOT NULL, reference_range TEXT NOT NULL, flag TEXT NOT NULL, date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, resource TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS appointment_date ON appointments(date, time);
    CREATE INDEX IF NOT EXISTS encounter_patient ON encounters(patient_id);
  `);
  migrateNoShowStatus(db);

  // Keep old free-form addresses intact while adding separate fields for new
  // registrations. ALTER TABLE preserves records, references, and indexes.
  const patientColumns = db.prepare("PRAGMA table_info(patients)").all() as {
    name: string;
  }[];
  for (const field of ["address_unit", "city", "state", "zip_code"])
    if (!patientColumns.some((column) => column.name === field))
      db.exec(`ALTER TABLE patients ADD COLUMN ${field} TEXT NOT NULL DEFAULT ''`);

  const userColumns = db.prepare("PRAGMA table_info(users)").all() as {
    name: string;
  }[];
  for (const table of ["appointments", "encounters"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    const fields =
      table === "encounters"
        ? {
            billing_account_id: "TEXT NOT NULL DEFAULT ''",
            billing_account_snapshot: "TEXT NOT NULL DEFAULT 'null'",
            wc_documentation: "TEXT NOT NULL DEFAULT 'null'",
          }
        : { billing_account_id: "TEXT NOT NULL DEFAULT ''" };
    for (const [name, definition] of Object.entries(fields))
      if (!columns.some((c) => c.name === name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  for (const field of ["is_admin", "is_active"])
    if (!userColumns.some((c) => c.name === field))
      db.exec(
        `ALTER TABLE users ADD COLUMN ${field} INTEGER NOT NULL DEFAULT ${field === "is_active" ? 1 : 0}`,
      );
  if (
    options.seedDemo !== false &&
    !db.prepare("SELECT id FROM users LIMIT 1").get()
  ) {
    db.exec("BEGIN");
    try {
      const addUser = db.prepare(
        "INSERT INTO users (id,name,email,password,role) VALUES (?, ?, ?, ?, ?)",
      );
      addUser.run(
        "usr-clinician",
        "Dr. Alex Morgan",
        "alex@cevrali.demo",
        hashPassword("CevraliDemo2026!"),
        "clinician",
      );
      addUser.run(
        "usr-reception",
        "Jamie Parker",
        "frontdesk@cevrali.demo",
        hashPassword("CevraliDemo2026!"),
        "receptionist",
      );
      const patients = [
        [
          "pat-001",
          "Olivia",
          "Bennett",
          "1989-04-12",
          "Female",
          "(415) 555-0101",
          "olivia@example.test",
          "San Francisco, CA",
          ["Penicillin"],
          ["Hypertension"],
          [{ name: "Lisinopril", dose: "10 mg", frequency: "Once daily" }],
        ],
        [
          "pat-002",
          "James",
          "Wilson",
          "1968-09-23",
          "Male",
          "(415) 555-0102",
          "james@example.test",
          "Oakland, CA",
          [],
          ["Type 2 diabetes"],
          [{ name: "Metformin", dose: "500 mg", frequency: "Twice daily" }],
        ],
        [
          "pat-003",
          "Sophia",
          "Martinez",
          "1995-02-18",
          "Female",
          "(415) 555-0103",
          "sophia@example.test",
          "San Francisco, CA",
          ["Sulfonamides"],
          ["Seasonal allergies"],
          [{ name: "Cetirizine", dose: "10 mg", frequency: "As needed" }],
        ],
        [
          "pat-004",
          "William",
          "Chen",
          "1976-11-05",
          "Male",
          "(415) 555-0104",
          "william@example.test",
          "Berkeley, CA",
          [],
          ["Hyperlipidemia"],
          [{ name: "Atorvastatin", dose: "20 mg", frequency: "Once daily" }],
        ],
        [
          "pat-005",
          "Emma",
          "Thompson",
          "1992-07-30",
          "Female",
          "(415) 555-0105",
          "emma@example.test",
          "San Francisco, CA",
          ["Latex"],
          [],
          [],
        ],
        [
          "pat-006",
          "Noah",
          "Davis",
          "1981-01-14",
          "Male",
          "(415) 555-0106",
          "noah@example.test",
          "Daly City, CA",
          [],
          ["Asthma"],
          [
            {
              name: "Albuterol inhaler",
              dose: "90 mcg",
              frequency: "As needed",
            },
          ],
        ],
        [
          "pat-007",
          "Isabella",
          "Robinson",
          "1959-06-08",
          "Female",
          "(415) 555-0107",
          "isabella@example.test",
          "San Francisco, CA",
          ["Codeine"],
          ["Osteoarthritis"],
          [],
        ],
        [
          "pat-008",
          "Lucas",
          "Patel",
          "2000-12-19",
          "Male",
          "(415) 555-0108",
          "lucas@example.test",
          "Oakland, CA",
          [],
          [],
          [],
        ],
      ];
      const addPatient = db.prepare(
        "INSERT INTO patients (id, first_name, last_name, dob, sex, phone, email, address, allergies, conditions, medications) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const p of patients)
        addPatient.run(
          ...(p.slice(0, 8) as string[]),
          ...p.slice(8).map((v) => JSON.stringify(v)),
        );
      const today = clinicDate();
      const appointments = [
        [
          "apt-001",
          "pat-001",
          "08:30",
          "Follow-up",
          "Blood pressure follow-up",
          "Completed",
        ],
        [
          "apt-002",
          "pat-002",
          "09:00",
          "Follow-up",
          "Diabetes management",
          "Completed",
        ],
        [
          "apt-003",
          "pat-003",
          "09:30",
          "Consultation",
          "Seasonal allergy symptoms",
          "In progress",
        ],
        [
          "apt-004",
          "pat-004",
          "10:00",
          "Annual physical",
          "Annual wellness examination",
          "Checked in",
        ],
        [
          "apt-005",
          "pat-005",
          "10:30",
          "Consultation",
          "New patient consultation",
          "Scheduled",
        ],
        [
          "apt-006",
          "pat-006",
          "11:00",
          "Follow-up",
          "Asthma follow-up",
          "Scheduled",
        ],
        [
          "apt-007",
          "pat-007",
          "13:00",
          "Follow-up",
          "Joint pain follow-up",
          "Scheduled",
        ],
        [
          "apt-008",
          "pat-008",
          "13:30",
          "Annual physical",
          "Preventive care visit",
          "Scheduled",
        ],
      ];
      const addAppointment = db.prepare(
        "INSERT INTO appointments (id, patient_id, date, time, type, reason, status, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const a of appointments)
        addAppointment.run(a[0], a[1], today, ...a.slice(2), "usr-clinician");
      const addEncounter = db.prepare(
        "INSERT INTO encounters (id, patient_id, appointment_id, author_id, chief_complaint, subjective, objective, assessment, plan, bp, pulse, temperature, status, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      addEncounter.run(
        "enc-001",
        "pat-001",
        "apt-001",
        "usr-clinician",
        "Blood pressure follow-up",
        "Patient reports feeling well. Taking medication as prescribed.",
        "Alert and comfortable. Heart regular. Lungs clear.",
        "Hypertension, stable on current treatment.",
        "Continue current regimen. Follow up in 3 months.",
        "122/78",
        "72",
        "36.7",
        "Signed",
        new Date().toISOString(),
      );
      addEncounter.run(
        "enc-002",
        "pat-002",
        "apt-002",
        "usr-clinician",
        "Diabetes management",
        "Routine follow-up. No new symptoms reported.",
        "Well appearing. No acute concerns on examination.",
        "Type 2 diabetes. Reviewing recent laboratory results.",
        "Discuss lifestyle goals and review at next visit.",
        "128/82",
        "76",
        "36.8",
        "Draft",
        null,
      );
      addEncounter.run(
        "enc-003",
        "pat-003",
        "apt-003",
        "usr-clinician",
        "Seasonal allergy symptoms",
        "Nasal congestion and sneezing for the past week.",
        "",
        "",
        "",
        "118/76",
        "68",
        "36.6",
        "Draft",
        null,
      );
      const addTask = db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, 0)");
      addTask.run(
        "task-001",
        "pat-002",
        "Review HbA1c results",
        "Lab review",
        "High",
      );
      addTask.run(
        "task-002",
        "pat-006",
        "Follow up on inhaler refill request",
        "Follow-up",
        "Normal",
      );
      addTask.run(
        "task-003",
        "pat-002",
        "Complete visit documentation",
        "Documentation",
        "Normal",
      );
      const addLab = db.prepare(
        "INSERT INTO labs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      addLab.run(
        "lab-001",
        "pat-002",
        "Hemoglobin A1c",
        "7.2",
        "%",
        "4.0–5.6",
        "High",
        today,
      );
      addLab.run(
        "lab-002",
        "pat-004",
        "LDL cholesterol",
        "108",
        "mg/dL",
        "<100",
        "High",
        today,
      );
      addLab.run(
        "lab-003",
        "pat-001",
        "Serum creatinine",
        "0.8",
        "mg/dL",
        "0.6–1.1",
        "Normal",
        today,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  initializeWorkflows(db);
  synchronizeNoShowStatuses(db);
  if (options.seedDemo !== false) {
    db.prepare(
      "INSERT OR IGNORE INTO users (id,name,email,password,role) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "usr-colleague",
      "Dr. Nina Patel",
      "nina@cevrali.demo",
      hashPassword("CevraliDemo2026!"),
      "clinician",
    );
    db.prepare("UPDATE users SET is_admin=1 WHERE id='usr-clinician'").run();
  }
  return db;
}
