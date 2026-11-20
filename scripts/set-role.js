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
//   npm run admin -- --db /srv/sonora/data/sonora.db list
//
// The database is resolved exactly as the server resolves it (src/config.js), so
// SONORA_DB, the data/ default and the --db flag all agree with the running
// process, and the path is printed before anything is changed. A missing file is
// a refusal, not a new empty database: this script used to be able to create a
// blank sonora.db that was not the instance the operator meant, and then report
// "No users yet" — indistinguishable from an empty install.
//
// The same result by hand:
//   sqlite3 data/sonora.db "UPDATE users SET role='admin' WHERE name='alice';"

import fs from 'node:fs';

const argv = process.argv.slice(2);
let dbFlag = null;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--db') {
    dbFlag = argv[i + 1] ?? null;
    i += 1;
  } else if (arg.startsWith('--db=')) {
    dbFlag = arg.slice('--db='.length);
  } else {
    positional.push(arg);
  }
}
if (dbFlag) {
  if (!dbFlag.trim()) {
    console.error('--db needs a path: --db <file>.');
    process.exit(2);
  }
  // The path must be in place before config.js is loaded: config reads its own
  // environment once, at import time.
  process.env.SONORA_DB = dbFlag;
}

const [command, name] = positional;
const COMMANDS = new Set(['list', 'promote', 'demote', 'disable', 'enable']);

// Imported dynamically so the flag above is applied first. config.js never
// touches SQLite, so importing it cannot create the file it is about to check.
const { config } = await import('../src/config.js');
const dbPath = config.dbPath;

function usage() {
  console.log(`Usage: npm run admin -- [--db <path>] <command> [name]

  list              show every account, its role and status
  promote <name>    grant administrator access
  demote <name>     remove administrator access
  disable <name>    block sign-in and revoke existing sessions
  enable <name>     allow sign-in again

Database: ${dbPath}`);
}

function commandError(message, status = 1) {
  return Object.assign(new Error(message), { status });
}

if (!command || !COMMANDS.has(command)) {
  usage();
  process.exitCode = command ? 2 : 0;
} else {
  await run(command, name);
}

async function run(selected, userName) {
  // Refused before src/db.js is imported, because importing it opens (and today
  // would create) the database file.
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}\n`
      + 'Nothing was changed. Start the server once to create it, or point '
      + 'SONORA_DB / --db at the instance you mean.');
    process.exitCode = 1;
    return;
  }

  const {
    db, findUser, getUser, setUserRole, setUserDisabled, countAdmins, listUsersWithStats,
    bumpSessionVersion, revokeAllRefreshTokens, deleteAllDevices, recordAudit, transaction,
  } = await import('../src/db.js');

  function requireUser(named) {
    if (!named) throw commandError('Missing a user name. Run without arguments for usage.', 2);
    const user = findUser(named);
    if (!user) throw commandError(`No user named "${named}".`);
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

  const name = userName;

  try {
    // Printed before the first write, so a log of what happened names the file.
    console.log(`Database: ${dbPath}`);
    switch (selected) {
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
    }
  } catch (err) {
    console.error(err?.message ?? err);
    process.exitCode = err?.status ?? 1;
  } finally {
    db.close();
  }
}
