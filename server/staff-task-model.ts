import type { StaffMessageView, StaffPerson } from "./staff-communication-model.js";

export type StaffTaskAssignment = {
  title: string;
  owner_id: string;
  due_date: string;
  priority: "High" | "Normal";
};

export type StaffTaskHistory = {
  revision: number;
  at: string;
  actor_id: string;
  actor_name: string;
  action: "Created" | "Updated" | "Completed" | "Reopened";
  before: (StaffTaskAssignment & { done: number }) | null;
  after: StaffTaskAssignment & { done: number };
};

export type StaffActionTask = StaffTaskAssignment & {
  id: string;
  conversation_id: string;
  message_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  done: number;
  revision: number;
  client_id: string;
  initial_assignment: StaffTaskAssignment;
  history: StaffTaskHistory[];
};

export type StaffTaskSummary = StaffTaskAssignment & {
  id: string;
  owner_name: string;
  done: number;
  revision: number;
};

export type StaffTaskView = Omit<StaffActionTask, "client_id" | "initial_assignment"> & {
  owner: StaffPerson;
  creator: StaffPerson;
  conversation: { id: string; name: string; kind: "channel" | "direct"; archived: boolean };
  source_message: Omit<StaffMessageView, "task">;
  can_edit: boolean;
  allowed_assignees: StaffPerson[];
};
