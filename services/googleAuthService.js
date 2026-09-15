const { OAuth2Client } = require('google-auth-library');

/**
 * Verifies a Google ID token (the "credential" the frontend gets from
 * Google Sign-In) and returns the verified profile info.
 * Throws if the token is invalid, expired, or was issued for a different app.
 *
 * @param {string} idToken - the raw credential string from Google Sign-In
 * @returns {Promise<{ googleId: string, email: string, name: string, picture: string }>}
 */
async function verifyGoogleToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not set in the .env file.');
  }
  if (!idToken) {
    throw new Error('A Google ID token is required.');
  }

  const client = new OAuth2Client(clientId);

  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: clientId });
  } catch (err) {
    const wrapped = new Error('Could not verify the Google sign-in token.');
    wrapped.statusCode = 401;
    throw wrapped;
  }

  const payload = ticket.getPayload();

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}

module.exports = { verifyGoogleToken };
