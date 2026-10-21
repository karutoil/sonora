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
  db, findUser, setUserRole, setUserDisabled, countAdmins, listUsersWithStats,
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

function requireUser(name) {
  if (!name) {
    console.error('Missing a user name. Run without arguments for usage.');
    process.exit(2);
  }
  const user = findUser(name);
  if (!user) {
    console.error(`No user named "${name}".`);
    process.exit(1);
  }
  return user;
}

function guardLastAdmin(user, verb) {
  if (user.role === 'admin' && countAdmins() <= 1) {
    console.error(`Refusing to ${verb} "${user.name}": they are the only active admin.`);
    console.error('Promote another account first, then try again.');
    process.exit(1);
  }
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
      if (user.role === 'admin') {
        console.log(`"${user.name}" is already an admin.`);
        break;
      }
      setUserRole(user.id, 'admin');
      console.log(`"${user.name}" is now an admin.`);
      break;
    }

    case 'demote': {
      const user = requireUser(name);
      guardLastAdmin(user, 'demote');
      setUserRole(user.id, 'user');
      console.log(`"${user.name}" is now a regular user.`);
      break;
    }

    case 'disable': {
      const user = requireUser(name);
      guardLastAdmin(user, 'disable');
      setUserDisabled(user.id, true);
      db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(user.id);
      console.log(`"${user.name}" is disabled and their sessions were revoked.`);
      break;
    }

    case 'enable': {
      const user = requireUser(name);
      setUserDisabled(user.id, false);
      console.log(`"${user.name}" can sign in again.`);
      break;
    }

    default:
      usage();
      process.exit(command ? 2 : 0);
  }
} finally {
  db.close();
}
