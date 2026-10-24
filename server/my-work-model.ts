import type { StaffAnnouncementView, StaffConversationView } from "./staff-communication-model.js";
import type { StaffTaskView } from "./staff-task-model.js";

export type MyWorkCareTask = {
  id: string;
  title: string;
  patient_id: string | null;
  patient_name: string;
  category: string;
  priority: "High" | "Normal";
  due_date: string;
  done: number;
  can_complete: boolean;
};

export type MyWorkReview = {
  id: string;
  kind: "result" | "document";
  title: string;
  patient_id: string;
  patient_name: string;
  priority: "High" | "Normal";
  due_date: string;
  recorded_at: string;
  destination: "orders" | "fax-inbox";
};

export type MyWorkAuthorization = {
  id: string;
  patient_id: string;
  patient_name: string;
  payer: string;
  status: string;
  due_date: string;
  overdue: boolean;
};

export type MyWorkDashboard = {
  viewer_id: string;
  today: string;
  clinical: boolean;
  counts: {
    assigned_tasks: number;
    overdue: number;
    due_today: number;
    awaiting_review: number;
    authorization_followups: number;
    unread_messages: number;
    announcements_to_acknowledge: number;
  };
  staff_tasks: StaffTaskView[];
  care_tasks: MyWorkCareTask[];
  reviews: MyWorkReview[];
  authorizations: MyWorkAuthorization[];
  conversations: StaffConversationView[];
  announcements: StaffAnnouncementView[];
};
