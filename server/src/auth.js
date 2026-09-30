'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { AppError } = require('./domain');
const COOKIE_NAME = 'ajo_session';
const TTL = 12 * 60 * 60 * 1000;
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
});
const hashPassword = (password) => bcrypt.hash(password, 12);
const verifyPassword = (password, hash) => bcrypt.compare(password, hash);
async function createSession(prisma, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      csrfToken: crypto.randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + TTL),
    },
  });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: TTL });
  res.clearCookie('ajo_token', { path: '/' });
  return session;
}
function requireAuth(prisma) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
        throw new AppError(401, 'Please log in.');
      const session = await prisma.session.findUnique({
        where: { tokenHash: tokenHash(token) },
        include: { user: true },
      });
      if (!session || session.expiresAt <= new Date())
        throw new AppError(401, 'Session expired. Please log in.');
      req.session = session;
      req.userId = session.userId;
      req.user = session.user;
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.get('x-csrf-token') !== session.csrfToken
      )
        throw new AppError(403, 'Refresh the page before making this change.');
      next();
    } catch (error) {
      next(error);
    }
  };
}
async function reauthenticate(req) {
  const password = req.body?.password;
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password) > 72 ||
    !(await verifyPassword(password, req.user.password))
  )
    throw new AppError(403, 'Confirm your current password to continue.');
}
module.exports = {
  COOKIE_NAME,
  cookieOptions,
  createSession,
  requireAuth,
  reauthenticate,
  hashPassword,
  verifyPassword,
};
