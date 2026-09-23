// src/prismaClient.js
// One shared Prisma Client instance for the whole app (avoids exhausting
// Neon's connection limit by creating a new client per request).

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = prisma;
