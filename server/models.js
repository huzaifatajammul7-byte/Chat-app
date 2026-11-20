import mongoose from 'mongoose';
const { Schema } = mongoose;
const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    avatar: { type: String, default: '' },
    about: { type: String, default: 'Hey there! I am using Chat.', maxlength: 120 },
    role: { type: String, default: 'user' },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const attSchema = new Schema(
  { id: Schema.Types.ObjectId, name: String, mime: String, size: Number, kind: String },
  { _id: false }
);
// Snapshot of the message being replied to (kept even if the original is later deleted).
const replySchema = new Schema(
  { id: Schema.Types.ObjectId, from: Schema.Types.ObjectId, text: String, kind: String, name: String },
  { _id: false }
);
const reactSchema = new Schema({ user: Schema.Types.ObjectId, emoji: String }, { _id: false });
const messageSchema = new Schema(
  {
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '', maxlength: 2000 },
    attachment: { type: attSchema, default: undefined },
    reply: { type: replySchema, default: undefined },
    reactions: { type: [reactSchema], default: [] },
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  },
  { timestamps: true }
);
messageSchema.index({ from: 1, to: 1, createdAt: 1 });
messageSchema.index({ to: 1, status: 1 });

// Uploaded files are stored in MongoDB in 3 MB chunks (each upload part stays small).
const fileSchema = new Schema(
  {
    owner: { type: String, index: true },
    name: String,
    mime: String,
    kind: String,
    size: Number,
    chunks: Number,
    ready: { type: Boolean, default: false },
    attached: { type: Boolean, default: false },
  },
  { timestamps: true }
);
fileSchema.index({ attached: 1, createdAt: 1 });
const chunkSchema = new Schema({ file: Schema.Types.ObjectId, n: Number, data: Buffer });
chunkSchema.index({ file: 1, n: 1 }, { unique: true });

// Login/signup attempts (auto-deleted after 15 minutes) for rate limiting.
const attemptSchema = new Schema({ key: { type: String, index: true }, createdAt: { type: Date, default: Date.now, expires: 900 } });

export const User = model('User', userSchema);
export const Message = model('Message', messageSchema);
export const FileDoc = model('FileDoc', fileSchema);
export const FileChunk = model('FileChunk', chunkSchema);
export const Attempt = model('Attempt', attemptSchema);
