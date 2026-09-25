// A small in-memory stand-in for the Mongoose User model: enough of MongoDB's filter and update language for the payment and plan
// code (equality, $ne, $lte, $gt, "an array contains this value"; $set, $inc, $push with $each / $slice). The users live in a Map
// keyed by id, so a test can read and change them directly.
const same = (a, b) => (a instanceof Date || b instanceof Date ? a != null && b != null && +a === +b : (a == null && b == null) || a === b);

function matchField(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === '$ne') return Array.isArray(actual) ? !actual.some((x) => same(x, v)) : !same(actual, v); // null also means "missing"
      if (op === '$lte') return actual != null && actual <= v;
      if (op === '$gt') return actual != null && actual > v;
      throw new Error('fake User collection: the operator ' + op + ' is not supported');
    });
  }
  if (Array.isArray(actual)) return actual.some((x) => same(x, cond));
  return same(actual, cond);
}

const matches = (id, user, filter) => Object.entries(filter).every(([k, cond]) => (k === '_id' ? same(String(id), String(cond)) : matchField(user[k], cond)));

function applyUpdate(user, update) {
  for (const [k, v] of Object.entries(update.$set || {})) user[k] = v;
  for (const [k, v] of Object.entries(update.$inc || {})) user[k] = (user[k] || 0) + v;
  for (const [k, v] of Object.entries(update.$push || {})) {
    const list = Array.isArray(user[k]) ? user[k] : [];
    if (v && typeof v === 'object' && '$each' in v) {
      list.push(...v.$each);
      user[k] = v.$slice ? list.slice(v.$slice) : list;
    } else {
      list.push(v);
      user[k] = list;
    }
  }
}

/**
 * @param {Map<string, object>} users
 * @param {{ beforeUpdate?: (filter: object, update: object) => void }} [hooks] beforeUpdate runs just before an update is matched
 *   (a test uses it to change the user "in between", the way a concurrent request would)
 */
function fakeUsers(users, hooks = {}) {
  const rows = (filter) => [...users.entries()].filter(([id, u]) => matches(id, u, filter || {}));
  const plain = ([id, u]) => ({ _id: id, ...u });
  return {
    findOne: (filter) => ({ lean: async () => { const first = rows(filter)[0]; return first ? plain(first) : null; } }),
    find: (filter) => ({ limit: (n) => ({ lean: async () => rows(filter).slice(0, n).map(plain) }), lean: async () => rows(filter).map(plain) }),
    exists: async (filter) => { const first = rows(filter)[0]; return first ? { _id: first[0] } : null; },
    updateOne: async (filter, update) => {
      if (hooks.beforeUpdate) hooks.beforeUpdate(filter, update);
      const first = rows(filter)[0];
      if (!first) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(first[1], update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

module.exports = { fakeUsers, matches, applyUpdate };
