#!/usr/bin/env node
// Assign the admin role directly in the database.
//
// This is the documented out-of-band path for the first admin (the bootstrap
// user is already one) and for recovery when the UI is unavailable. It talks to
// the same SQLite file the server uses, so no HTTP session is required.
//
//   npm run admin -- list
//   npm run admin -- promote alice
//   npm run admin -- demote alice
//   npm run admin -- disable alice
//   npm run admin -- enable alice
//
// The same result by hand:
//   sqlite3 data/sonora.db "UPDATE users SET role='admin' WHERE name='alice';"

import {
  db, findUser, getUser, setUserRole, setUserDisabled, countAdmins, listUsersWithStats,
  bumpSessionVersion, revokeAllRefreshTokens, deleteAllDevices, recordAudit, transaction,
} from '../src/db.js';

const [command, name] = process.argv.slice(2);

function usage() {
  console.log(`Usage: npm run admin -- <command> [name]

  list              show every account, its role and status
  promote <name>    grant administrator access
  demote <name>     remove administrator access
  disable <name>    block sign-in and revoke existing sessions
  enable <name>     allow sign-in again

Database: ${process.env.SONORA_DB ?? 'data/sonora.db (default)'}`);
}

function commandError(message, status = 1) {
  return Object.assign(new Error(message), { status });
}

function requireUser(userName) {
  if (!userName) throw commandError('Missing a user name. Run without arguments for usage.', 2);
  const user = findUser(userName);
  if (!user) throw commandError(`No user named "${userName}".`);
  return user;
}

/** Runs inside BEGIN IMMEDIATE; never trust a count read before the write lock. */
function guardLastAdmin(user, verb) {
  if (user.role === 'admin' && !user.disabled && countAdmins() <= 1) {
    throw commandError(`Refusing to ${verb} "${user.name}": they are the only active admin.\n`
      + 'Promote another account first, then try again.');
  }
}

/** Re-read, mutate and audit in one transaction shared with the HTTP admin path. */
function auditedMutation(user, change) {
  return transaction(() => {
    const current = getUser(user.id);
    if (!current) throw commandError(`No user named "${user.name}".`);
    const detail = change(current);
    // A no-op is not a security change, and needs neither a write nor an audit.
    if (detail === null) return { current, changed: false };
    recordAudit({
      actorId: null, actorName: 'cli', action: 'user.update',
      target: current.name, detail,
    });
    return { current, changed: true };
  });
}

try {
  switch (command) {
    case 'list': {
      const users = listUsersWithStats();
      if (!users.length) {
        console.log('No users yet. Start the server once to create the bootstrap admin.');
        break;
      }
      const pad = (s, n) => String(s).padEnd(n);
      console.log(`${pad('NAME', 22)} ${pad('ROLE', 8)} ${pad('STATUS', 10)} PLAYS`);
      for (const u of users) {
        console.log(`${pad(u.name, 22)} ${pad(u.role, 8)} ${pad(u.disabled ? 'disabled' : 'active', 10)} ${u.plays}`);
      }
      break;
    }

    case 'promote': {
      const user = requireUser(name);
      const { changed } = auditedMutation(user, (current) => {
        if (current.role === 'admin') return null;
        setUserRole(current.id, 'admin');
        return 'role=admin';
      });
      console.log(changed ? `"${user.name}" is now an admin.` : `"${user.name}" is already an admin.`);
      break;
    }

    case 'demote': {
      const user = requireUser(name);
      const { changed } = auditedMutation(user, (current) => {
        if (current.role !== 'admin') return null;
        guardLastAdmin(current, 'demote');
        setUserRole(current.id, 'user');
        return 'role=user';
      });
      console.log(changed ? `"${user.name}" is now a regular user.` : `"${user.name}" is already a regular user.`);
      break;
    }

    case 'disable': {
      const user = requireUser(name);
      const { changed } = auditedMutation(user, (current) => {
        if (current.disabled) return null;
        guardLastAdmin(current, 'disable');
        setUserDisabled(current.id, true);
        bumpSessionVersion(current.id);
        const tokens = revokeAllRefreshTokens(current.id);
        const devices = deleteAllDevices(current.id);
        return `disabled; refresh tokens revoked=${tokens}; devices removed=${devices}`;
      });
      console.log(changed
        ? `"${user.name}" is disabled and their sessions and remembered devices were revoked.`
        : `"${user.name}" is already disabled; no credentials were reissued.`);
      break;
    }

    case 'enable': {
      const user = requireUser(name);
      const { changed } = auditedMutation(user, (current) => {
        if (!current.disabled) return null;
        setUserDisabled(current.id, false);
        return 'enabled';
      });
      console.log(changed ? `"${user.name}" can sign in again.` : `"${user.name}" is already enabled.`);
      break;
    }

    default:
      usage();
      process.exitCode = command ? 2 : 0;
  }
} catch (err) {
  console.error(err?.message ?? err);
  process.exitCode = err?.status ?? 1;
} finally {
  db.close();
}
