const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema({
  peerId:    { type: String },
  name:      { type: String },
  email:     { type: String },
  avatarUrl: { type: String },
  joinedAt:  { type: Date, default: Date.now },
}, { _id: false });

const meetingSchema = new mongoose.Schema({
  roomCode:         { type: String, required: true, index: true },
  date:             { type: Date,   required: true },   // meeting start date
  day:              { type: String, required: true },   // "Monday", "Tuesday", …
  startedAt:        { type: Date,   required: true },
  endedAt:          { type: Date },
  host: {
    peerId:    { type: String },
    name:      { type: String },
    email:     { type: String },
    avatarUrl: { type: String },
  },
  participants:     { type: [participantSchema], default: [] },
  participantCount: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model("Meeting", meetingSchema);
