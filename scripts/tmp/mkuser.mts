import '../../src/server/env';
import { getFirebaseAdmin } from '../../src/server/firebaseAdmin';
const admin = getFirebaseAdmin()!;
const email = 'tradingvibes-verify@example.com';
const existing = await admin.auth.getUserByEmail(email).catch(() => null);
if (existing) await admin.auth.deleteUser(existing.uid);
const created = await admin.auth.createUser({ email, password: 'Verify!23456789', displayName: 'Verify Bot' });
console.log('CREATED', created.uid);
