export type IdentityStatus = "active" | "disabled";

export interface UserRecord {
  id: string;
  name: string;
  status: IdentityStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  status: IdentityStatus;
  createdAt: number;
  updatedAt: number;
}
