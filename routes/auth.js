const express = require("express");
const { OAuth2Client } = require("google-auth-library");

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// POST /api/auth/google
// Verifies a Google ID token and returns user profile info
router.post("/google", async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: "No credential provided" });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const user = {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      emailVerified: payload.email_verified,
    };

    console.log(`[Auth] Google login: ${user.email} (${user.name})`);
    return res.json({ user });
  } catch (err) {
    console.error("[Auth] Token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid token" });
  }
});

module.exports = router;
