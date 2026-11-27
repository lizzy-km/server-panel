'use strict';
/**
 * MariaDB/MySQL and PostgreSQL on a managed server, driven from the UI.
 *
 * Safety rules:
 *  - names are validated against a strict pattern and then quoted; only generated or pattern-checked passwords are
 *    ever placed in SQL, and SQL travels on stdin, so passwords never appear in a process command line or a log;
 *  - system databases/users cannot be dropped or reused;
 *  - destructive actions (drop, import) need the database name typed back, and an import takes a safety dump first;
 *  - the databases are administered as the OS superuser (root's unix socket for MariaDB, the `postgres` OS user for
 *    PostgreSQL), so no database admin password is stored anywhere.
 */
const crypto = require('crypto');
const { httpError } = require('./auth');
const { shq } = require('./host');

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const PASS_RE = /^[A-Za-z0-9!@#%^*_+=.,:;?~-]{12,128}$/;
const ENGINES = {
  mysql: { label: 'MariaDB / MySQL', port: 3306, systemDbs: ['mysql', 'information_schema', 'performance_schema', 'sys'], systemUsers: ['root', 'mysql', 'mariadb.sys', 'mariadb', 'PUBLIC', ''] },
  postgres: { label: 'PostgreSQL', port: 5432, systemDbs: ['postgres', 'template0', 'template1'], systemUsers: ['postgres'] },
};

const genPassword = (n = 24) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
};

function checkName(kind, v) {
  const n = String(v || '');
  if (!NAME_RE.test(n)) throw httpError(400, `${kind} name: 1-32 characters, letters, digits and underscores, starting with a letter`);
  return n;
}
function checkEngine(e) {
  if (!ENGINES[e]) throw httpError(400, 'engine must be mysql or postgres');
  return e;
}
function checkPassword(pw) {
  if (pw === undefined || pw === null || pw === '') return genPassword();
  if (!PASS_RE.test(String(pw))) throw httpError(400, 'Password: 12-128 characters from letters, digits and ! @ # % ^ * _ + = . , : ; ? ~ - (no spaces or quotes)');
  return String(pw);
}

const STATUS_SCRIPT = `USE_SUDO=\${USE_SUDO:-0}
priv() { if [ "$USE_SUDO" = 1 ] && [ "$(id -u)" != 0 ]; then sudo -n "$@"; else "$@"; fi; }
echo "m_installed=$( (command -v mariadbd || command -v mysqld) >/dev/null 2>&1 && echo 1 || echo 0)"
echo "m_client=$(command -v mysql >/dev/null 2>&1 && echo 1 || echo 0)"
echo "m_version=$(priv mysql -N -B -e 'select version()' 2>/dev/null | head -1)"
echo "m_dump=$(command -v mysqldump >/dev/null 2>&1 && echo 1 || echo 0)"
echo "p_installed=$( (command -v postgres || ls /usr/lib/postgresql/*/bin/postgres /usr/pgsql-*/bin/postgres /usr/bin/postgres) >/dev/null 2>&1 && echo 1 || echo 0)"
echo "p_client=$(command -v psql >/dev/null 2>&1 && echo 1 || echo 0)"
echo "p_version=$(sudo -n -u postgres psql -X -At -c 'show server_version' 2>/dev/null | head -1)"
echo "p_dump=$(command -v pg_dump >/dev/null 2>&1 && echo 1 || echo 0)"
`;

class DatabaseManager {
  constructor({ servers, config }) { Object.assign(this, { servers, config }); }

  hostOf(serverId) { return this.servers.entry(serverId).host; }

  // ------------------------------------------------------------------ low level (SQL on stdin)

  async sql(host, engine, sql, { db } = {}) {
    let r;
    if (engine === 'mysql') r = await host.runPriv('mysql', ['-N', '-B', ...(db ? ['-D', db] : [])], { stdin: sql, timeout: 120000 });
    else r = await host.run('sudo', ['-n', '-u', 'postgres', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-X', '-At', '-F', '\t', '-d', db || 'postgres'], { stdin: sql, timeout: 120000 });
    if (!r.ok) {
      const msg = (r.stderr || r.stdout || '').trim();
      if (r.missing || /command not found/.test(msg)) throw httpError(400, `${ENGINES[engine].label} is not installed on this server (Databases → Install).`);
      if (/sudo: /.test(msg)) throw httpError(400, 'Managing PostgreSQL needs passwordless sudo for the SSH user.');
      if (/Can't connect|Connection refused|could not connect|No such file or directory/i.test(msg)) throw httpError(400, `${ENGINES[engine].label} is installed but not running.`);
      throw httpError(400, msg.replace(/^ERROR[^:]*:\s*/, '').split('\n')[0] || 'The database server rejected the request');
    }
    return r.stdout.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
  }

  // ------------------------------------------------------------------ status / overview

  async status(serverId) {
    const host = this.hostOf(serverId);
    const r = await host.run('bash', ['-s'], { stdin: `USE_SUDO=${host.useSudo ? 1 : 0}\n${STATUS_SCRIPT}`, timeout: 30000 });
    const o = {};
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const eng = (p, name) => ({
      engine: name, label: ENGINES[name].label, installed: o[`${p}_installed`] === '1' || !!o[`${p}_version`], client: o[`${p}_client`] === '1',
      running: !!o[`${p}_version`], version: o[`${p}_version`] || '', dump: o[`${p}_dump`] === '1',
    });
    return { engines: [eng('m', 'mysql'), eng('p', 'postgres')], sudo: host.useSudo || host.username === 'root' };
  }

  async overview(serverId, engine) {
    checkEngine(engine);
    const host = this.hostOf(serverId);
    const E = ENGINES[engine];
    if (engine === 'mysql') {
      const dbs = await this.sql(host, 'mysql', "SELECT s.schema_name, COALESCE(ROUND(SUM(t.data_length + t.index_length) / 1048576, 2), 0), COUNT(t.table_name) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name GROUP BY s.schema_name ORDER BY 1;");
      const users = await this.sql(host, 'mysql', "SELECT user, host FROM mysql.user WHERE user <> '' ORDER BY user, host;");
      const grants = await this.sql(host, 'mysql', "SELECT REPLACE(SUBSTRING_INDEX(grantee, '@', 1), \"'\", ''), table_schema FROM information_schema.schema_privileges GROUP BY 1, 2;");
      const byUser = {};
      for (const [u, d] of grants) (byUser[u] = byUser[u] || []).push(d);
      return {
        engine, databases: dbs.map(([name, mb, tables]) => ({ name, sizeMb: Number(mb), tables: Number(tables), system: E.systemDbs.includes(name) })),
        users: users.map(([name, h]) => ({ name, host: h, databases: byUser[name] || [], system: E.systemUsers.includes(name) })),
      };
    }
    const dbs = await this.sql(host, 'postgres', "SELECT d.datname, pg_database_size(d.datname), pg_get_userbyid(d.datdba) FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1;");
    const users = await this.sql(host, 'postgres', "SELECT rolname, rolsuper FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg\\_%' ORDER BY 1;");
    const owned = {};
    for (const [name, , owner] of dbs) (owned[owner] = owned[owner] || []).push(name);
    return {
      engine, databases: dbs.map(([name, bytes, owner]) => ({ name, sizeMb: Math.round(Number(bytes) / 10485.76) / 100, owner, system: E.systemDbs.includes(name) })),
      users: users.map(([name, sup]) => ({ name, host: 'local', databases: owned[name] || [], system: E.systemUsers.includes(name) || sup === 't' })),
    };
  }

  // ------------------------------------------------------------------ create / drop

  /** Create a database, and optionally a dedicated user with full access to it. Returns the password ONCE. */
  async createDatabase(serverId, { engine, name, user, password }) {
    checkEngine(engine);
    const db = checkName('Database', name);
    if (ENGINES[engine].systemDbs.includes(db.toLowerCase())) throw httpError(400, 'That name is reserved by the database server');
    const host = this.hostOf(serverId);
    let pw = null; let u = null;
    if (user) {
      u = checkName('User', user);
      if (ENGINES[engine].systemUsers.includes(u)) throw httpError(400, 'That user name is reserved');
      pw = checkPassword(password);
    }
    if (engine === 'mysql') {
      await this.sql(host, 'mysql', `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
      if (u) {
        try { await this.sql(host, 'mysql', `CREATE USER '${u}'@'localhost' IDENTIFIED BY '${pw}'; GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${u}'@'localhost'; FLUSH PRIVILEGES;`); }
        catch (e) { await this.sql(host, 'mysql', `DROP DATABASE \`${db}\`;`).catch(() => {}); throw e; }
      }
    } else {
      if (u) await this.sql(host, 'postgres', `CREATE ROLE "${u}" LOGIN PASSWORD '${pw}';`);
      try { await this.sql(host, 'postgres', `CREATE DATABASE "${db}" ${u ? `OWNER "${u}"` : ''} ENCODING 'UTF8' TEMPLATE template0;`); }
      catch (e) { if (u) await this.sql(host, 'postgres', `DROP ROLE IF EXISTS "${u}";`).catch(() => {}); throw e; }
      // PostgreSQL lets everybody connect by default; only people who are granted access should
      await this.sql(host, 'postgres', `REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;`);
    }
    return { name: db, user: u, password: pw, host: '127.0.0.1', port: ENGINES[engine].port };
  }

  async dropDatabase(serverId, { engine, name, confirm }) {
    checkEngine(engine);
    const db = checkName('Database', name);
    if (confirm !== db) throw httpError(400, 'Type the database name to confirm');
    if (ENGINES[engine].systemDbs.includes(db.toLowerCase())) throw httpError(400, 'System databases cannot be dropped');
    const host = this.hostOf(serverId);
    await this.sql(host, engine, engine === 'mysql' ? `DROP DATABASE \`${db}\`;` : `DROP DATABASE "${db}" WITH (FORCE);`);
    return { ok: true };
  }

  // ------------------------------------------------------------------ users

  async createUser(serverId, { engine, name, password, database }) {
    checkEngine(engine);
    const u = checkName('User', name);
    if (ENGINES[engine].systemUsers.includes(u)) throw httpError(400, 'That user name is reserved');
    const pw = checkPassword(password);
    const host = this.hostOf(serverId);
    if (engine === 'mysql') {
      await this.sql(host, 'mysql', `CREATE USER '${u}'@'localhost' IDENTIFIED BY '${pw}';`);
      if (database) await this.grant(serverId, { engine, user: u, database, action: 'grant' });
    } else {
      await this.sql(host, 'postgres', `CREATE ROLE "${u}" LOGIN PASSWORD '${pw}';`);
      if (database) await this.grant(serverId, { engine, user: u, database, action: 'grant' });
    }
    return { name: u, password: pw };
  }

  async resetPassword(serverId, { engine, name, password }) {
    checkEngine(engine);
    const u = checkName('User', name);
    if (ENGINES[engine].systemUsers.includes(u)) throw httpError(400, 'System users are not managed here');
    const pw = checkPassword(password);
    const host = this.hostOf(serverId);
    await this.sql(host, engine, engine === 'mysql' ? `ALTER USER '${u}'@'localhost' IDENTIFIED BY '${pw}';` : `ALTER ROLE "${u}" WITH PASSWORD '${pw}';`);
    return { name: u, password: pw };
  }

  async grant(serverId, { engine, user, database, action }) {
    checkEngine(engine);
    const u = checkName('User', user); const db = checkName('Database', database);
    if (!['grant', 'revoke'].includes(action)) throw httpError(400, 'action must be grant or revoke');
    if (ENGINES[engine].systemUsers.includes(u)) throw httpError(400, 'System users are not managed here');
    if (ENGINES[engine].systemDbs.includes(db.toLowerCase())) throw httpError(400, 'System databases are not managed here');
    const host = this.hostOf(serverId);
    if (engine === 'mysql') {
      await this.sql(host, 'mysql', action === 'grant' ? `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${u}'@'localhost'; FLUSH PRIVILEGES;` : `REVOKE ALL PRIVILEGES ON \`${db}\`.* FROM '${u}'@'localhost'; FLUSH PRIVILEGES;`);
    } else {
      if (action === 'grant') {
        await this.sql(host, 'postgres', `GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${u}";`);
        await this.sql(host, 'postgres', `GRANT ALL ON SCHEMA public TO "${u}"; GRANT ALL ON ALL TABLES IN SCHEMA public TO "${u}"; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${u}"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${u}"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${u}";`, { db });
      } else {
        // an owner keeps every right, so hand the database and its tables to the admin role first
        await this.sql(host, 'postgres', `DO $$ BEGIN IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${db}') = '${u}' THEN ALTER DATABASE "${db}" OWNER TO postgres; END IF; END $$;`);
        await this.sql(host, 'postgres', `DO $$ DECLARE r record; BEGIN FOR r IN SELECT format('%I.%I', schemaname, tablename) AS n FROM pg_tables WHERE tableowner = '${u}' AND schemaname NOT IN ('pg_catalog','information_schema') LOOP EXECUTE 'ALTER TABLE ' || r.n || ' OWNER TO postgres'; END LOOP; FOR r IN SELECT format('%I.%I', schemaname, sequencename) AS n FROM pg_sequences WHERE sequenceowner = '${u}' LOOP EXECUTE 'ALTER SEQUENCE ' || r.n || ' OWNER TO postgres'; END LOOP; END $$; REVOKE ALL ON SCHEMA public FROM "${u}"; REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${u}"; REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "${u}";`, { db });
        await this.sql(host, 'postgres', `REVOKE ALL PRIVILEGES ON DATABASE "${db}" FROM "${u}";`);
      }
    }
    return { ok: true };
  }

  async dropUser(serverId, { engine, name, confirm }) {
    checkEngine(engine);
    const u = checkName('User', name);
    if (confirm !== u) throw httpError(400, 'Type the user name to confirm');
    if (ENGINES[engine].systemUsers.includes(u)) throw httpError(400, 'System users cannot be dropped');
    const host = this.hostOf(serverId);
    if (engine === 'mysql') await this.sql(host, 'mysql', `DROP USER '${u}'@'localhost';`);
    else {
      const owned = (await this.sql(host, 'postgres', `SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = '${u}');`)).map((r) => r[0]);
      if (owned.length) throw httpError(400, `This user owns database(s): ${owned.join(', ')}. Drop or reassign them first.`);
      const dbs = (await this.sql(host, 'postgres', `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate;`)).map((r) => r[0]);
      for (const d of dbs) await this.sql(host, 'postgres', `DROP OWNED BY "${u}";`, { db: d });
      await this.sql(host, 'postgres', `DROP ROLE "${u}";`);
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ dump / restore (also used by backups)

  /** Shell fragment that writes a gzip'd dump of one database to a file ($1 = output file). */
  static dumpCommand(engine, db) {
    const d = shq(db);
    return engine === 'mysql'
      ? `priv mysqldump --single-transaction --quick --routines --triggers --events ${d} | gzip -c > "$1"`
      : `sudo -n -u postgres pg_dump --no-owner --clean --if-exists ${d} | gzip -c > "$1"`;
  }

  async exportDatabase(serverId, { engine, name }) {
    checkEngine(engine);
    const db = checkName('Database', name);
    const host = this.hostOf(serverId);
    const dir = this.config.exportDir;
    const file = `${db}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.sql.gz`;
    const script = `set -euo pipefail
USE_SUDO=${host.useSudo ? 1 : 0}
priv() { if [ "$USE_SUDO" = 1 ] && [ "$(id -u)" != 0 ]; then sudo -n "$@"; else "$@"; fi; }
priv mkdir -p ${shq(dir)}; priv chown "$(id -un)" ${shq(dir)}; chmod 700 ${shq(dir)}
set -- ${shq(dir + '/' + file)}
${DatabaseManager.dumpCommand(engine, db)}
chmod 600 "$1"
gzip -t "$1"
# keep the five newest exports of this database
ls -1t ${shq(dir)}/${shq(db)}-*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "$(stat -c %s "$1")"
`;
    const r = await host.run('bash', ['-s'], { stdin: script, timeout: 600000 });
    if (!r.ok) throw httpError(500, `Export failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
    return { file, path: `${dir}/${file}`, bytes: Number(r.stdout.trim().split('\n').pop()) || 0 };
  }

  async exportStream(serverId, file) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}-\d{14}\.sql\.gz$/.test(String(file))) throw httpError(400, 'Invalid export name');
    const host = this.hostOf(serverId);
    const p = `${this.config.exportDir}/${file}`;
    const st = await host.fs.stat(p).catch(() => null);
    if (!st || st.type !== 'file') throw httpError(404, 'Export not found (it may have been replaced by a newer one)');
    return { size: st.size, name: file, stream: host.fs.createReadStream(p) };
  }

  /** Replace a database with the contents of an uploaded .sql / .sql.gz (after a safety dump). */
  async importDatabase(serverId, { engine, name, confirm, req, filename, limit }) {
    checkEngine(engine);
    const db = checkName('Database', name);
    if (confirm !== db) throw httpError(400, 'Type the database name to confirm: importing replaces its current contents');
    if (ENGINES[engine].systemDbs.includes(db.toLowerCase())) throw httpError(400, 'System databases cannot be replaced');
    if (!/\.sql(\.gz)?$/i.test(String(filename || ''))) throw httpError(400, 'Upload a .sql or .sql.gz file');
    const host = this.hostOf(serverId);
    const dir = this.config.exportDir;
    const gz = /\.gz$/i.test(filename);
    const tmp = `${dir}/import-${crypto.randomBytes(6).toString('hex')}${gz ? '.sql.gz' : '.sql'}`;
    await host.runPriv('mkdir', ['-p', dir]); await host.runPriv('chown', [host.username || 'root', dir]);
    // stream the upload to the server (size-limited), then restore from it
    const { Transform } = require('stream');
    let size = 0;
    const counter = new Transform({ transform(c, _e, cb) { size += c.length; if (size > limit) cb(httpError(413, 'Upload too large')); else cb(null, c); } });
    req.on('error', (e) => counter.destroy(e));
    try { await host.fs.writeFrom(tmp, req.pipe(counter)); } catch (e) { await host.fs.rm(tmp).catch(() => {}); throw e; }
    try {
      const safety = await this.exportDatabase(serverId, { engine, name: db }).catch(() => null);
      const run = (file, isGz) => host.run('bash', ['-s'], { stdin: DatabaseManager.restoreScript(engine, db, file, isGz, host.useSudo), timeout: 1800000 });
      const r = await run(tmp, gz);
      if (!r.ok) {
        // put the previous contents back so a bad file never leaves the database empty or half-loaded
        const back = safety ? await run(safety.path, true) : null;
        throw httpError(400, `Import failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}. ${safety ? (back && back.ok ? 'The database was restored to its previous contents.' : `The previous contents are saved as ${safety.file}.`) : 'No safety copy could be made.'}`);
      }
      return { ok: true, bytes: size, safetyDump: safety ? safety.file : null };
    } finally { await host.fs.rm(tmp).catch(() => {}); }
  }

  /** Drop and recreate a database, then load a .sql(.gz) file into it. */
  static restoreScript(engine, db, file, gz, useSudo) {
    const reader = gz ? `gunzip -c ${shq(file)}` : `cat ${shq(file)}`;
    return engine === 'mysql'
      ? `set -euo pipefail\nUSE_SUDO=${useSudo ? 1 : 0}\npriv() { if [ "$USE_SUDO" = 1 ] && [ "$(id -u)" != 0 ]; then sudo -n "$@"; else "$@"; fi; }\npriv mysql -e 'DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'\n${reader} | priv mysql ${shq(db)}\n`
      : `set -euo pipefail
PSQL() { sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 "$@"; }
OWNER=$(PSQL -At -c "select pg_get_userbyid(datdba) from pg_database where datname = '${db}'" 2>/dev/null || true)
GRANTEES=$(PSQL -At -c "select distinct pg_get_userbyid(a.grantee) from pg_database d, aclexplode(d.datacl) a where d.datname = '${db}' and a.grantee <> 0 and a.privilege_type = 'CONNECT'" 2>/dev/null || true)
[ -n "$OWNER" ] || OWNER=postgres
PSQL -c 'DROP DATABASE IF EXISTS "${db}" WITH (FORCE)'
PSQL -c "CREATE DATABASE \\"${db}\\" ENCODING UTF8 TEMPLATE template0 OWNER \\"$OWNER\\""
LOAD=0
${reader} | PSQL -d ${shq(db)} >/dev/null || LOAD=1
# the file was loaded by the admin role: give everything back to the people who had access before
PSQL -d ${shq(db)} >/dev/null <<SQL
DO \\$\\$ DECLARE r record; BEGIN
  FOR r IN SELECT format('%I.%I', schemaname, tablename) AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') LOOP EXECUTE 'ALTER TABLE ' || r.n || ' OWNER TO "$OWNER"'; END LOOP;
  FOR r IN SELECT format('%I.%I', schemaname, sequencename) AS n FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog','information_schema') LOOP EXECUTE 'ALTER SEQUENCE ' || r.n || ' OWNER TO "$OWNER"'; END LOOP;
END \\$\\$;
SQL
PSQL -c 'REVOKE ALL ON DATABASE "${db}" FROM PUBLIC' >/dev/null
for G in $GRANTEES; do
  [ "$G" = "$OWNER" ] && continue
  PSQL -c "GRANT ALL PRIVILEGES ON DATABASE \\"${db}\\" TO \\"$G\\""
  PSQL -d ${shq(db)} -c "GRANT ALL ON SCHEMA public TO \\"$G\\"; GRANT ALL ON ALL TABLES IN SCHEMA public TO \\"$G\\"; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO \\"$G\\"" >/dev/null
done
exit $LOAD
`;
  }

  /** The settings an app needs to talk to a database on this server (Laravel names + DATABASE_URL). */
  static connectionEnv(engine, { database, user, password }) {
    const port = ENGINES[engine].port;
    return {
      DB_CONNECTION: engine === 'mysql' ? 'mysql' : 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_DATABASE: database, DB_USERNAME: user, DB_PASSWORD: password,
      DATABASE_URL: `${engine === 'mysql' ? 'mysql' : 'postgresql'}://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
    };
  }
}

module.exports = { DatabaseManager, ENGINES, genPassword, NAME_RE, PASS_RE };
