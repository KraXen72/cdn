// SQL helper: initialize sql.js and provide schema utilities
import { log } from './logger.js';

export async function initSQL() {
  // Caller should ensure initSqlJs is available (e.g. via CDN in HTML)
  return await initSqlJs({
    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
  });
}

export function createSchema(db) {
  log("Generating NewPipe Schema (Excluding reserved sqlite_sequence table)...", "schema");
  const schema = `
            CREATE TABLE android_metadata (locale TEXT);
            CREATE TABLE ` + "`subscriptions`" + ` (` + "`uid`" + ` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ` + "`service_id`" + ` INTEGER NOT NULL, ` + "`url`" + ` TEXT, ` + "`name`" + ` TEXT, ` + "`avatar_url`" + ` TEXT, ` + "`subscriber_count`" + ` INTEGER, ` + "`description`" + ` TEXT, ` + "`notification_mode`" + ` INTEGER NOT NULL);
            CREATE UNIQUE INDEX ` + "`index_subscriptions_service_id_url`" + ` ON ` + "`subscriptions`" + ` (` + "`service_id`" + `,` + "`url`" + `);
            CREATE TABLE ` + "`search_history`" + ` (` + "`creation_date`" + ` INTEGER, ` + "`service_id`" + ` INTEGER NOT NULL, ` + "`search`" + ` TEXT, ` + "`id`" + ` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL);
            CREATE INDEX ` + "`index_search_history_search`" + ` ON ` + "`search_history`" + ` (` + "`search`" + `);
            CREATE TABLE ` + "`streams`" + ` (` + "`uid`" + ` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ` + "`service_id`" + ` INTEGER NOT NULL, ` + "`url`" + ` TEXT NOT NULL, ` + "`title`" + ` TEXT NOT NULL, ` + "`stream_type`" + ` TEXT NOT NULL, ` + "`duration`" + ` INTEGER NOT NULL, ` + "`uploader`" + ` TEXT NOT NULL, ` + "`uploader_url`" + ` TEXT, ` + "`thumbnail_url`" + ` TEXT, ` + "`view_count`" + ` INTEGER, ` + "`textual_upload_date`" + ` TEXT, ` + "`upload_date`" + ` INTEGER, ` + "`is_upload_date_approximation`" + ` INTEGER);
            CREATE UNIQUE INDEX ` + "`index_streams_service_id_url`" + ` ON ` + "`streams`" + ` (` + "`service_id`" + `,` + "`url`" + `);
            CREATE TABLE ` + "`stream_history`" + ` (` + "`stream_id`" + ` INTEGER NOT NULL, ` + "`access_date`" + ` INTEGER NOT NULL, ` + "`repeat_count`" + ` INTEGER NOT NULL, PRIMARY KEY(` + "`stream_id`" + `, ` + "`access_date`" + `), FOREIGN KEY(` + "`stream_id`" + `) REFERENCES ` + "`streams`" + `(` + "`uid`" + `) ON UPDATE CASCADE ON DELETE CASCADE);
                -- FIX APPLIED HERE: Room-compatible stream_state (progress_time first, stream_id PK, FOREIGN KEY)
                CREATE TABLE ` + "`stream_state`" + ` (` + "`progress_time`" + ` INTEGER NOT NULL, ` + "`stream_id`" + ` INTEGER NOT NULL, PRIMARY KEY(` + "`stream_id`" + `), FOREIGN KEY(` + "`stream_id`" + `) REFERENCES ` + "`streams`" + `(` + "`uid`" + `) ON UPDATE CASCADE ON DELETE CASCADE);
            CREATE TABLE ` + "`playlist_stream_join`" + ` (` + "`playlist_id`" + ` INTEGER NOT NULL, ` + "`stream_id`" + ` INTEGER NOT NULL, ` + "`join_index`" + ` INTEGER NOT NULL, PRIMARY KEY(` + "`playlist_id`" + `, ` + "`join_index`" + `), FOREIGN KEY(` + "`playlist_id`" + `) REFERENCES ` + "`playlists`" + `(` + "`uid`" + `) ON UPDATE CASCADE ON DELETE CASCADE);
            CREATE TABLE ` + "`playlists`" + ` (` + "`uid`" + ` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ` + "`name`" + ` TEXT, ` + "`is_thumbnail_permanent`" + ` INTEGER NOT NULL, ` + "`thumbnail_stream_id`" + ` INTEGER NOT NULL, ` + "`display_index`" + ` INTEGER NOT NULL);
            CREATE TABLE ` + "`remote_playlists`" + ` (` + "`uid`" + ` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ` + "`service_id`" + ` INTEGER NOT NULL, ` + "`name`" + ` TEXT, ` + "`url`" + ` TEXT, ` + "`thumbnail_url`" + ` TEXT, ` + "`uploader`" + ` TEXT, ` + "`display_index`" + ` INTEGER NOT NULL, ` + "`stream_count`" + ` INTEGER);
            INSERT INTO android_metadata VALUES ('en_US');
        `;
  db.run(schema);
  log("Schema created.");
}

export function ensureStreamStateSchema(db) {
  try {
    const fkRes = db.exec("PRAGMA foreign_key_list('stream_state')");
    const infoRes = db.exec("PRAGMA table_info('stream_state')");
    let hasFK = false;
    if (fkRes && fkRes.length > 0 && fkRes[0].values && fkRes[0].values.length > 0) hasFK = true;

    let colsOk = false;
    if (infoRes && infoRes.length > 0 && infoRes[0].values.length >= 2) {
      const rows = infoRes[0].values;
      const cols = rows.map(r => r[1]);
      const pks = rows.map(r => r[5]);
      if (cols[0] === 'progress_time' && cols[1] === 'stream_id' && pks[0] === 0 && pks[1] === 1) {
        colsOk = true;
      }
    }

    if (!hasFK || !colsOk) {
      log('Patching stream_state schema to Room-compatible definition...', 'schema');
      db.run('BEGIN TRANSACTION');
      const exists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_state'");
      if (exists && exists.length > 0 && exists[0].values.length > 0) {
        db.run("ALTER TABLE stream_state RENAME TO stream_state_old");
        db.run("CREATE TABLE `stream_state` (`progress_time` INTEGER NOT NULL, `stream_id` INTEGER NOT NULL, PRIMARY KEY(`stream_id`), FOREIGN KEY(`stream_id`) REFERENCES `streams`(`uid`) ON UPDATE CASCADE ON DELETE CASCADE)");
        try {
          db.run("INSERT INTO stream_state (progress_time, stream_id) SELECT progress_time, stream_id FROM stream_state_old");
        } catch (e) {
          log('Note: could not copy old stream_state rows: ' + (e.message || e.toString()), 'warn');
        }
        db.run("DROP TABLE stream_state_old");
      } else {
        db.run("CREATE TABLE IF NOT EXISTS `stream_state` (`progress_time` INTEGER NOT NULL, `stream_id` INTEGER NOT NULL, PRIMARY KEY(`stream_id`), FOREIGN KEY(`stream_id`) REFERENCES `streams`(`uid`) ON UPDATE CASCADE ON DELETE CASCADE)");
      }
      db.run('COMMIT');
      log('stream_state schema patched.', 'schema');
    } else {
      log('stream_state schema OK.', 'schema');
    }
  } catch (e) {
    log('Failed to ensure stream_state schema: ' + (e.message || e.toString()), 'err');
  }
}
