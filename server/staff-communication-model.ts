export type StaffPerson = {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
};

export type StaffConversation = {
  id: string;
  kind: "channel" | "direct";
  name: string;
  description: string;
  member_ids: string[];
  created_by: string;
  created_at: string;
  archived: boolean;
  revision: number;
  client_id?: string;
};

export type StaffMessage = {
  id: string;
  conversation_id: string;
  author_id: string;
  text: string;
  sequence: number;
  created_at: string;
  client_id: string;
};

export type StaffMessageView = Omit<StaffMessage, "client_id" | "author_id"> & {
  author: StaffPerson;
};

export type StaffConversationView = StaffConversation & {
  unread_count: number;
  last_message: StaffMessageView | null;
  can_post: boolean;
};

export type StaffAnnouncement = {
  id: string;
  title: string;
  body: string;
  priority: "Normal" | "Urgent";
  requires_acknowledgement: boolean;
  author_id: string;
  created_at: string;
  recipient_ids: string[];
  acknowledgements: Record<string, string>;
  archived: boolean;
  revision: number;
  client_id: string;
};

export type StaffAnnouncementView = Omit<StaffAnnouncement,
  "author_id" | "recipient_ids" | "acknowledgements" | "client_id"
> & {
  author: StaffPerson;
  needs_acknowledgement: boolean;
  acknowledged_at: string | null;
  acknowledged_count: number;
  recipient_count: number;
  acknowledgements?: { member: StaffPerson; acknowledged_at: string | null }[];
};

export type StaffCommunicationState = {
  conversations: StaffConversation[];
  messages: StaffMessage[];
  read_cursors: Record<string, Record<string, number>>;
  announcements: StaffAnnouncement[];
};

export type StaffUnread = {
  unread_messages: number;
  unacknowledged_announcements: number;
  total: number;
};

export type StaffWorkspace = StaffUnread & {
  viewer_id: string;
  can_manage: boolean;
  directory: StaffPerson[];
  conversations: StaffConversationView[];
  announcements: StaffAnnouncementView[];
};

export type StaffMessagePage = {
  conversation: StaffConversationView;
  messages: StaffMessageView[];
  has_more: boolean;
  oldest_sequence: number | null;
  latest_sequence: number;
};
