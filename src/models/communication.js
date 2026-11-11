const { Schema, createModel, reference } = require("./schema");

const Announcement = createModel("Announcement", {
  title: String,
  body: String,
  actor: reference("User"),
});

const Notification = createModel("Notification", {
  recipient: reference("User"),
  message: String,
  read: { type: Boolean, default: false },
});

const AuditLog = createModel("AuditLog", {
  actor: reference("User", false),
  action: String,
  entity: String,
  entityId: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
});

const AiLog = createModel("AiLog", {
  actor: reference("User"),
  mode: String,
  status: String,
  tools: [String],
  error: String,
});

module.exports = { Announcement, Notification, AuditLog, AiLog };
