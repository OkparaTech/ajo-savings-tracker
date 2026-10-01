const crypto = require('crypto');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode(length = 10) {
  return Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
}
module.exports = { generateInviteCode };
