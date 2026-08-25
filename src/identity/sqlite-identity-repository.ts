import { randomBytes } from "node:crypto";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import type {
  IdentityStatus,
  ProjectRecord,
  UserRecord
} from "./types.js";

interface UserRow {
  id: string;
  name: string;
  status: IdentityStatus;
  created_at: number;
  updated_at: number;
}

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  status: IdentityStatus;
  created_at: number;
  updated_at: number;
}

function userFromRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assertName(name: string): string {
  const value = name.trim();
  if (value === "" || value.length > 200) throw new TypeError("Identity name is invalid");
  return value;
}

export class SqliteIdentityRepository {
  constructor(private readonly store: SqliteStore) {}

  createUser(name: string): UserRecord {
    const normalized = assertName(name);
    return this.store.immediate((database) => {
      const now = Date.now();
      const id = `usr_${randomBytes(12).toString("hex")}`;
      database.prepare(`
        INSERT INTO users(id, name, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
      `).run(id, normalized, now, now);
      return userFromRow(database.prepare(
        "SELECT id,name,status,created_at,updated_at FROM users WHERE id = ?"
      ).get(id) as UserRow);
    });
  }

  listUsers(): UserRecord[] {
    return this.store.read((database) => (database.prepare(`
      SELECT id,name,status,created_at,updated_at FROM users ORDER BY created_at,id
    `).all() as UserRow[]).map(userFromRow));
  }

  setUserStatus(id: string, status: IdentityStatus): UserRecord {
    return this.store.immediate((database) => {
      const result = database.prepare(
        "UPDATE users SET status = ?, updated_at = ? WHERE id = ?"
      ).run(status, Date.now(), id);
      if (result.changes !== 1) throw new Error("User was not found");
      return userFromRow(database.prepare(
        "SELECT id,name,status,created_at,updated_at FROM users WHERE id = ?"
      ).get(id) as UserRow);
    });
  }

  createProject(userId: string, name: string): ProjectRecord {
    const normalized = assertName(name);
    return this.store.immediate((database) => {
      const user = database.prepare(
        "SELECT status FROM users WHERE id = ?"
      ).get(userId) as { status: IdentityStatus } | undefined;
      if (user === undefined || user.status !== "active") {
        throw new Error("Active user was not found");
      }
      const now = Date.now();
      const id = `prj_${randomBytes(12).toString("hex")}`;
      database.prepare(`
        INSERT INTO projects(id,user_id,name,status,plan_id,created_at,updated_at)
        VALUES (?, ?, ?, 'active', 'plan_legacy', ?, ?)
      `).run(id, userId, normalized, now, now);
      return projectFromRow(database.prepare(`
        SELECT id,user_id,name,status,created_at,updated_at FROM projects WHERE id = ?
      `).get(id) as ProjectRow);
    });
  }

  listProjects(userId?: string): ProjectRecord[] {
    return this.store.read((database) => {
      const rows = userId === undefined
        ? database.prepare(`
          SELECT id,user_id,name,status,created_at,updated_at FROM projects
          ORDER BY created_at,id
        `).all()
        : database.prepare(`
          SELECT id,user_id,name,status,created_at,updated_at FROM projects
          WHERE user_id = ? ORDER BY created_at,id
        `).all(userId);
      return (rows as ProjectRow[]).map(projectFromRow);
    });
  }

  setProjectStatus(id: string, status: IdentityStatus): ProjectRecord {
    return this.store.immediate((database) => {
      const result = database.prepare(
        "UPDATE projects SET status = ?, updated_at = ? WHERE id = ?"
      ).run(status, Date.now(), id);
      if (result.changes !== 1) throw new Error("Project was not found");
      return projectFromRow(database.prepare(`
        SELECT id,user_id,name,status,created_at,updated_at FROM projects WHERE id = ?
      `).get(id) as ProjectRow);
    });
  }

  activeBinding(userId: string, projectId: string): boolean {
    return this.store.read((database) => database.prepare(`
      SELECT 1 AS active
      FROM projects p JOIN users u ON u.id = p.user_id
      WHERE p.id = ? AND p.user_id = ? AND p.status = 'active' AND u.status = 'active'
    `).get(projectId, userId) !== undefined);
  }
}
