// A small in-memory stand-in for a Mongoose model: a list of plain rows (each with an _id), with enough of MongoDB's filter and update
// language for the queue / lease code - $or, equality where null also means "missing", $lt, $lte, $gt, $ne, $in; $set, $inc - and
// findOne, findOneAndUpdate (new: true / false), find(...).sort().limit() and updateOne / updateMany. Rows come back as documents with toObject().
const same = (a, b) => (a instanceof Date || b instanceof Date ? a != null && b != null && +a === +b : (a == null && b == null) || a === b);

function matchField(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === '$ne') return !same(actual, v);
      if (op === '$lt') return actual != null && actual < v;
      if (op === '$lte') return actual != null && actual <= v;
      if (op === '$gt') return actual != null && actual > v;
      if (op === '$in') return v.some((x) => same(actual, x));
      throw new Error('fake model: the operator ' + op + ' is not supported');
    });
  }
  return same(actual, cond);
}

function matches(row, filter) {
  return Object.entries(filter).every(([k, cond]) => (k === '$or' ? cond.some((f) => matches(row, f)) : matchField(row[k], cond)));
}

function applyUpdate(row, update) {
  const plain = Object.keys(update).some((k) => k.startsWith('$')) ? update : { $set: update };
  Object.assign(row, plain.$set || {});
  for (const [k, v] of Object.entries(plain.$inc || {})) row[k] = (row[k] || 0) + v;
}

const asDoc = (row) => ({ ...row, toObject() { const { toObject, ...rest } = this; return { ...rest }; } });

/** @param {object[]} rows the collection; a test edits it directly */
function fakeModel(rows) {
  const find = (filter) => rows.filter((r) => matches(r, filter || {}));
  return {
    rows,
    findOne: async (filter) => { const r = find(filter)[0]; return r ? asDoc(r) : null; },
    findById: (id) => {
      const r = rows.find((x) => same(String(x._id), String(id)));
      const chain = { select() { return chain; }, lean: async () => (r ? { ...r } : null), then(resolve, reject) { return Promise.resolve(r ? asDoc(r) : null).then(resolve, reject); } };
      return chain;
    },
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const r = find(filter)[0];
      if (!r) return null;
      const before = asDoc(r);
      applyUpdate(r, update);
      return opts.new === false ? before : asDoc(r);
    },
    updateOne: async (filter, update) => {
      const r = find(filter)[0];
      if (!r) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(r, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    updateMany: async (filter, update) => {
      const list = find(filter);
      list.forEach((r) => applyUpdate(r, update));
      return { matchedCount: list.length, modifiedCount: list.length };
    },
    find: (filter) => {
      let list = find(filter);
      const chain = {
        sort(spec) {
          const [[key, dir]] = Object.entries(spec);
          // like MongoDB: a missing / null value sorts first when ascending (last when descending), and equal values keep their order
          list = [...list].sort((a, b) => {
            const x = a[key]; const y = b[key];
            if (x == null && y == null) return 0;
            if (x == null) return -dir;
            if (y == null) return dir;
            return x < y ? -dir : x > y ? dir : 0;
          });
          return chain;
        },
        limit(n) { list = list.slice(0, n); return chain; },
        populate() { return chain; },
        select() { return chain; },
        lean() { return Promise.resolve(list.map((r) => ({ ...r }))); },
        then(resolve, reject) { return Promise.resolve(list.map(asDoc)).then(resolve, reject); },
      };
      return chain;
    },
  };
}

module.exports = { fakeModel, matches, applyUpdate };
