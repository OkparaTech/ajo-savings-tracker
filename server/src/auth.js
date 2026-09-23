// src/auth.js
// Password hashing + JWT-in-httpOnly-cookie authentication.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail loudly at startup rather than silently signing tokens with `undefined`.
  throw new Error('JWT_SECRET is not set. Add it to your .env file (see .env.example).');
}

const COOKIE_NAME = 'ajo_token';
const TOKEN_TTL = '30d';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Express middleware: requires a valid session, attaches req.userId.
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired — please log in again.' });
  }
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
};
