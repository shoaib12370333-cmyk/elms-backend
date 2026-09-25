const mongoose = require('mongoose');

// A named number that only goes up (invoice numbers). Incremented atomically, so two payments never share a number.
const counterSchema = new mongoose.Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } });

module.exports = mongoose.model('Counter', counterSchema);
