// 17TRACK's status-push webhook: refused without the right secret (17TRACK does not sign these requests, so the
// secret in the URL is the only thing stopping a forged push), applies every accepted item's status, and always
// answers 200 - even on our own error - so 17TRACK never retries into a retry storm.
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const updates = [];
stub('models/trackingLinksModel', { updateStatusByTrackingNumber: async (number, carrier, status) => { updates.push({ number, carrier, status }); } });
stub('services/track17Service', {
  statusFromTrackInfo: (trackInfo) => {
    const s = trackInfo?.latest_status;
    if (!s) return null;
    return { status: s.status, detail: trackInfo.latest_event?.description || null, at: trackInfo.latest_event?.time_utc ? new Date(trackInfo.latest_event.time_utc) : null };
  },
});

process.env.TRACK17_WEBHOOK_SECRET = 'sekret123';
const router = require('../routes/track17Webhook');
const handler = router.stack.find((l) => l.route && l.route.path === '/:secret' && l.route.methods.post).route.stack[0].handle;
const post = async (secret, body) => {
  const res = { statusCode: null, sendStatus(c) { this.statusCode = c; return this; } };
  await handler({ params: { secret }, body }, res);
  return res;
};

(async () => {
  // wrong / missing secret: refused, nothing applied
  let res = await post('wrong-secret', { data: { accepted: [{ number: 'N1', carrier: 1, track_info: { latest_status: { status: 'Delivered' } } }] } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(updates.length, 0);

  // correct secret: every accepted item is applied
  res = await post('sekret123', {
    data: {
      accepted: [
        { number: 'N1', carrier: 1, track_info: { latest_status: { status: 'InTransit' }, latest_event: { description: 'Left facility', time_utc: '2026-03-01T00:00:00Z' } } },
        { number: 'N2', carrier: 2, track_info: { latest_status: { status: 'Delivered' }, latest_event: { description: 'Delivered', time_utc: '2026-03-02T00:00:00Z' } } },
      ],
    },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(updates.length, 2);
  assert.strictEqual(updates[0].number, 'N1'); assert.strictEqual(updates[0].status.status, 'InTransit');
  assert.strictEqual(updates[1].number, 'N2'); assert.strictEqual(updates[1].status.status, 'Delivered');

  // an item with no track_info/latest_status is skipped, not crashed on
  updates.length = 0;
  res = await post('sekret123', { data: { accepted: [{ number: 'N3', carrier: 1 }] } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(updates.length, 0);

  // a malformed body still answers 200 (never makes 17TRACK retry)
  res = await post('sekret123', {});
  assert.strictEqual(res.statusCode, 200);

  console.log('17track webhook tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
