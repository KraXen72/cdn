import { SERVICE_ID_YOUTUBE, DEFAULT_PREFERENCES } from '../constants.js';
import { log } from '../logger.js';
import { getTimestamp, downloadFile } from '../utils.js';
import { createSchema, ensureStreamStateSchema } from '../sqlHelper.js';

export async function convertToNewPipe(npFile, ltFile, mode, SQL) {
  log("Starting conversion to NewPipe format...");

  let db;
  let zip = new JSZip();
  let streamStateDebug = '';
  let existingPreferences = null;
  let existingSettings = null;

  // 1. Setup DB
  if (mode === 'merge' && npFile) {
    log("Loading existing NewPipe backup...");
    const npData = await npFile.arrayBuffer();
    const sourceZip = await JSZip.loadAsync(npData);

    if (sourceZip.file("newpipe.db")) {
      const dbData = await sourceZip.file("newpipe.db").async("uint8array");
      db = new SQL.Database(dbData);
      log("Database loaded. Running integrity check...");
      const tablesRes = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';");
      if (tablesRes && tablesRes[0] && tablesRes[0].values) {
        log(`Existing NewPipe database contains: ${tablesRes[0].values.flat().join(', ')} tables.`, "schema");
      }

      try {
        ensureStreamStateSchema(db);
        try {
          const ti = db.exec("PRAGMA table_info('stream_state')") || [];
          const fk = db.exec("PRAGMA foreign_key_list('stream_state')") || [];
          const create = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='stream_state'") || [];
          streamStateDebug += 'PRAGMA table_info("stream_state"):\n';
          if (ti.length > 0) streamStateDebug += JSON.stringify(ti[0], null, 2) + '\n';
          streamStateDebug += '\nPRAGMA foreign_key_list("stream_state"):\n';
          if (fk.length > 0) streamStateDebug += JSON.stringify(fk[0], null, 2) + '\n';
          streamStateDebug += '\nCREATE statement:\n';
          if (create.length > 0 && create[0].values && create[0].values.length > 0) streamStateDebug += create[0].values[0][0] + '\n';
        } catch (e) {
          streamStateDebug += 'Failed to collect stream_state debug info: ' + (e.message || e.toString()) + '\n';
        }
      } catch (e) {
        log("Warning: failed to ensure stream_state schema: " + (e.message || e.toString()), "warn");
      }

    } else {
      throw new Error("Invalid NewPipe backup: missing newpipe.db");
    }

    if (sourceZip.file("preferences.json")) {
      existingPreferences = await sourceZip.file("preferences.json").async("string");
    }
    if (sourceZip.file("newpipe.settings")) {
      existingSettings = await sourceZip.file("newpipe.settings").async("blob");
    }

  } else {
    log("Creating new NewPipe database...");
    db = new SQL.Database();
    createSchema(db);
    try {
      const ti = db.exec("PRAGMA table_info('stream_state')") || [];
      const fk = db.exec("PRAGMA foreign_key_list('stream_state')") || [];
      const create = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='stream_state'") || [];
      streamStateDebug += 'PRAGMA table_info("stream_state"):\n';
      if (ti.length > 0) streamStateDebug += JSON.stringify(ti[0], null, 2) + '\n';
      streamStateDebug += '\nPRAGMA foreign_key_list("stream_state"):\n';
      if (fk.length > 0) streamStateDebug += JSON.stringify(fk[0], null, 2) + '\n';
      streamStateDebug += '\nCREATE statement:\n';
      if (create.length > 0 && create[0].values && create[0].values.length > 0) streamStateDebug += create[0].values[0][0] + '\n';
    } catch (e) {
      streamStateDebug += 'Failed to collect stream_state debug info (new DB): ' + (e.message || e.toString()) + '\n';
    }
  }

  // 2. Load LibreTube Data
  log("Parsing LibreTube JSON...");
  const ltText = await ltFile.text();
  const ltData = JSON.parse(ltText);

  db.run("BEGIN TRANSACTION");

  // --- Subscriptions ---
  try {
    log("Processing Subscriptions...");
    if (mode === 'merge') {
      db.run(`DELETE FROM subscriptions WHERE service_id = ${SERVICE_ID_YOUTUBE}`);
    }

    let subCount = 0;
    if (ltData.subscriptions) {
      const stmt = db.prepare("INSERT INTO subscriptions (service_id, url, name, avatar_url, subscriber_count, notification_mode) VALUES (?, ?, ?, ?, ?, ?)");
      ltData.subscriptions.forEach(sub => {
        try {
          const url = sub.url || `https://www.youtube.com/channel/${sub.channelId}`;
          const name = sub.name || "Unknown";
          const avatarUrl = sub.avatar || sub.avatarUrl || null;
          if (!url.includes("youtube.com") && !url.includes("youtu.be")) {
            log(`Dropped non-YouTube subscription: ${name} (${url})`, "warn");
            return;
          }

          stmt.run([
            SERVICE_ID_YOUTUBE,
            url,
            name,
            avatarUrl,
            null,
            1
          ]);
          subCount++;
        } catch (e) {
          log(`ERROR inserting subscription ${sub.name}: ${e.message || e.toString()}`, "err");
        }
      });
      stmt.free();
    }
    log(`Inserted ${subCount} subscriptions.`);
  } catch (e) {
    log(`FATAL ERROR during Subscriptions phase: ${e.message || e.toString()}`, "err");
    throw e;
  }

  // --- Playlists ---
  try {
    log("Processing Playlists...");
    if (mode === 'merge') {
      db.run("DELETE FROM playlists");
      db.run("DELETE FROM playlist_stream_join");
      db.run("DELETE FROM remote_playlists");
      log("Cleared existing playlists and joins.");
    }

    let plCount = 0;
    if (ltData.localPlaylists) {
      const streamInsert = db.prepare("INSERT OR IGNORE INTO streams (service_id, url, title, stream_type, duration, uploader, upload_date, thumbnail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const playlistInsert = db.prepare("INSERT INTO playlists (name, is_thumbnail_permanent, thumbnail_stream_id, display_index) VALUES (?, ?, ?, ?)");
      const joinInsert = db.prepare("INSERT INTO playlist_stream_join (playlist_id, stream_id, join_index) VALUES (?, ?, ?)");

      for (const lp of ltData.localPlaylists) {
        const plName = lp.playlist.name || "Untitled";
        try {
          const tempRes = db.exec(`SELECT uid FROM playlists WHERE name = '${plName.replace(/'/g, "''")}'`);
          if (tempRes.length > 0) {
            log(`Skipping duplicate local playlist: ${plName}`, "warn");
            continue;
          }

          playlistInsert.run([plName, 0, -1, plCount]);
          const plIdResult = db.exec("SELECT last_insert_rowid()");
          const plId = plIdResult[0].values[0][0];

          let joinIndex = 0;
          for (const vid of lp.videos) {
            const vidUrl = `https://www.youtube.com/watch?v=${vid.videoId}`;
            if (!vid.videoId) {
              log(`Skipped video in playlist ${plName} due to missing videoId.`, "warn");
              continue;
            }
            try {
              const streamTitle = vid.title || "Unknown";
              const uploaderName = vid.uploader || "Unknown";
              const durationSec = vid.duration || 0;
              const uploadDateTs = vid.uploadDate ? new Date(vid.uploadDate).getTime() / 1000 : null;
              const thumbnailUrl = vid.thumbnailUrl || null;

              streamInsert.run([
                SERVICE_ID_YOUTUBE,
                vidUrl,
                streamTitle,
                "VIDEO_STREAM",
                durationSec,
                uploaderName,
                uploadDateTs,
                thumbnailUrl
              ]);

              const streamIdRes = db.exec(`SELECT uid FROM streams WHERE service_id=${SERVICE_ID_YOUTUBE} AND url='${vidUrl.replace(/'/g, "''")}'`);
              if (streamIdRes.length > 0 && streamIdRes[0].values.length > 0) {
                const streamId = streamIdRes[0].values[0][0];
                joinInsert.run([plId, streamId, joinIndex++]);
              } else {
                log(`Warning: Could not find/insert stream for video ${streamTitle}`, "warn");
              }
            } catch (videoError) {
              log(`ERROR processing video "${vid.title}" in playlist "${plName}": ${videoError.message || videoError.toString()}`, "err");
            }
          }
          plCount++;
        } catch (playlistError) {
          log(`FATAL ERROR processing playlist "${plName}": ${playlistError.message || playlistError.toString()}`, "err");
          throw playlistError;
        }
      }
      streamInsert.free();
      playlistInsert.free();
      joinInsert.free();
    }
    log(`Processed ${plCount} local playlists.`);
  } catch (e) {
    log(`FATAL ERROR during Local Playlists phase: ${e.message || e.toString()}`, "err");
    throw e;
  }

  // --- Remote Playlists (Bookmarks) ---
  try {
    log("Processing Remote Playlist Bookmarks...");
    let rplCount = 0;
    const stmt = db.prepare("INSERT INTO remote_playlists (service_id, name, url, thumbnail_url, uploader, display_index, stream_count) VALUES (?, ?, ?, ?, ?, ?, ?)");

    if (ltData.playlistBookmarks) {
      for (const rb of ltData.playlistBookmarks) {
        try {
          const url = rb.url || (rb.playlistId ? `https://www.youtube.com/playlist?list=${rb.playlistId}` : null);
          if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
            log(`Dropped non-YouTube remote playlist: ${rb.playlistName || 'Untitled'}`, "warn");
            continue;
          }

          const playlistName = rb.playlistName || rb.name || "Untitled";
          const thumbnailUrl = rb.thumbnailUrl || null;
          const uploader = rb.uploader || "Unknown";
          const streamCount = typeof rb.videos === 'number' ? rb.videos : 0;

          stmt.run([
            SERVICE_ID_YOUTUBE,
            playlistName,
            url,
            thumbnailUrl,
            uploader,
            rplCount++,
            streamCount
          ]);
        } catch (e) {
          log(`ERROR inserting remote playlist ${rb.playlistName || 'Untitled'}: ${e.message || e.toString()}`, "err");
        }
      }
      stmt.free();
    }
    log(`Processed ${rplCount} remote playlist bookmarks.`);
  } catch (e) {
    log(`FATAL ERROR during Remote Playlists phase: ${e.message || e.toString()}`, "err");
    throw e;
  }

  // --- Finalize Transaction ---
  try {
    log("Committing transaction...");
    db.run("COMMIT");
  } catch (e) {
    log(`FATAL ERROR on COMMIT: ${e.message || e.toString()}`, "err");
    throw e;
  }

  // 4. Export
  log("Exporting database...");
  const data = db.export();
  zip.file("newpipe.db", data);

  if (existingPreferences) {
    zip.file("preferences.json", existingPreferences);
    log("Preserved existing preferences.json.");
  } else {
    zip.file("preferences.json", JSON.stringify(DEFAULT_PREFERENCES, null, 2));
    log("Created default preferences.json.");
  }

  if (existingSettings) {
    zip.file("newpipe.settings", existingSettings);
    log("Preserved existing newpipe.settings.");
  }

  zip.file('stream_state_debug.txt', streamStateDebug || 'No stream_state debug information collected.');
  log('Attached stream_state_debug.txt to zip for inspection.', 'schema');
  if (streamStateDebug) {
    const preview = streamStateDebug.split('\n').slice(0, 12).join('\n');
    log('stream_state_debug preview:\n' + preview, 'schema');
  }

  const blob = await zip.generateAsync({type:"blob"});
  const timestamp = getTimestamp();
  downloadFile(blob, "newpipe_converted.zip", timestamp);
  log("Done! File downloaded.", "info");
}
