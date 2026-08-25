import { describe, expect, it } from "vitest";
import { SqliteApiKeyRepository } from "../../src/api-keys/sqlite-api-key-repository.js";
import { SqliteIdentityRepository } from "../../src/identity/sqlite-identity-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

describe("identity repository", () => {
  it("creates users and projects and disables their API keys transitively", () => {
    const store = new SqliteStore(":memory:");
    const identities = new SqliteIdentityRepository(store);
    const keys = new SqliteApiKeyRepository(store);
    const user = identities.createUser("Studio A");
    const project = identities.createProject(user.id, "Campaign");
    const key = keys.create("Renderer", {
      userId: user.id,
      projectId: project.id,
      scopes: ["video:create", "video:read"]
    });
    expect(keys.authenticate(key.secret)).toMatchObject({
      userId: user.id,
      projectId: project.id,
      scopes: ["video:create", "video:read"]
    });
    identities.setProjectStatus(project.id, "disabled");
    expect(keys.authenticate(key.secret)).toBeNull();
    identities.setProjectStatus(project.id, "active");
    expect(keys.authenticate(key.secret)).not.toBeNull();
    identities.setUserStatus(user.id, "disabled");
    expect(keys.authenticate(key.secret)).toBeNull();
    store.close();
  });

  it("rejects a project for a missing or disabled user", () => {
    const store = new SqliteStore(":memory:");
    const identities = new SqliteIdentityRepository(store);
    expect(() => identities.createProject("missing", "Project")).toThrow();
    const user = identities.createUser("Disabled");
    identities.setUserStatus(user.id, "disabled");
    expect(() => identities.createProject(user.id, "Project")).toThrow();
    store.close();
  });
});
