const axios = require('axios');

const BASE = 'https://api.17track.net/track/v2.2';

function apiKey() {
  const key = process.env.TRACK17_API_KEY;
  if (!key) throw new Error('TRACK17_API_KEY is not set.');
  return key;
}

function headers() {
  return { '17token': apiKey(), 'Content-Type': 'application/json' };
}

/**
 * Registers a tracking number with 17TRACK so it starts polling the real carrier. Carrier is optional - 17TRACK
 * auto-detects it for most carriers - and its own numeric carrier code (needed for later lookups/webhooks) comes
 * back in the response.
 */
async function registerTracking(trackingNumber, carrier) {
  const body = [{ number: trackingNumber, ...(carrier ? { carrier } : {}), auto_detection: true }];
  const res = await axios.post(`${BASE}/register`, body, { headers: headers() });
  const data = res.data;
  if (data.code !== 0) throw new Error('17TRACK register failed: ' + (data.data?.errors?.[0]?.message || JSON.stringify(data)));
  const accepted = data.data?.accepted?.[0];
  if (!accepted) {
    const rejected = data.data?.rejected?.[0];
    throw new Error(rejected?.error?.message || 'This tracking number was not accepted.');
  }
  return { carrier: accepted.carrier };
}

/** One tracking number's current status, straight from 17TRACK (not the cached copy in our own DB). */
async function getTrackInfo(trackingNumber, carrier) {
  const res = await axios.post(`${BASE}/gettrackinfo`, [{ number: trackingNumber, carrier }], { headers: headers() });
  const accepted = res.data?.data?.accepted?.[0];
  if (!accepted) return null;
  return statusFromTrackInfo(accepted.track_info);
}

/** Pulls out just what the tracking page needs from 17TRACK's track_info object (shared by gettrackinfo and the webhook). */
function statusFromTrackInfo(trackInfo) {
  const latestStatus = trackInfo?.latest_status;
  const latestEvent = trackInfo?.latest_event;
  if (!latestStatus) return null;
  return {
    status: latestStatus.status || null,
    detail: latestEvent?.description || null,
    at: latestEvent?.time_utc ? new Date(latestEvent.time_utc) : null,
  };
}

module.exports = { registerTracking, getTrackInfo, statusFromTrackInfo };
