import { SERVICE_ID_YOUTUBE } from '../constants.js';
import { log } from '../logger.js';
import { getTimestamp, downloadFile } from '../utils.js';

export async function convertToLibreTube(npFile, ltFile, mode, SQL) {
  log("Starting conversion to LibreTube format...");
  
  let targetData = {
    watchHistory: [],
    subscriptions: [],
    playlistBookmarks: [],
    localPlaylists: [],
    preferences: [] 
  };

  if (mode === 'merge' && ltFile) {
    log("Reading target LibreTube file...");
    const text = await ltFile.text();
    targetData = JSON.parse(text);
    targetData.subscriptions = [];
    targetData.playlistBookmarks = [];
    targetData.localPlaylists = [];
    log("Target LibreTube file loaded and old playlist/subscription data cleared for merge.");
  }

  log("Reading NewPipe backup...");
  const npData = await npFile.arrayBuffer();
  const npZip = await JSZip.loadAsync(npData);
  const dbFile = npZip.file("newpipe.db");
  if (!dbFile) throw new Error("NewPipe ZIP must contain newpipe.db");
  const dbData = await dbFile.async("uint8array");
  const db = new SQL.Database(dbData);
  log("NewPipe database loaded.");

  try {
    let streamStateDebugInput = '';
    const ti = db.exec("PRAGMA table_info('stream_state')") || [];
    const fk = db.exec("PRAGMA foreign_key_list('stream_state')") || [];
    const create = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='stream_state'") || [];
    streamStateDebugInput += 'PRAGMA table_info("stream_state"):\n';
    if (ti.length > 0) streamStateDebugInput += JSON.stringify(ti[0], null, 2) + '\n';
    streamStateDebugInput += '\nPRAGMA foreign_key_list("stream_state"):\n';
    if (fk.length > 0) streamStateDebugInput += JSON.stringify(fk[0], null, 2) + '\n';
    streamStateDebugInput += '\nCREATE statement:\n';
    if (create.length > 0 && create[0].values && create[0].values.length > 0) streamStateDebugInput += create[0].values[0][0] + '\n';

    const dbgBlob = new Blob([streamStateDebugInput || 'No stream_state debug info collected.'], {type: 'text/plain'});
    const timestamp = getTimestamp();
    downloadFile(dbgBlob, 'stream_state_debug_input.txt', timestamp);
    log('Downloaded separate stream_state debug file for input NewPipe DB.', 'schema');
  } catch (e) {
    log('Failed to collect input stream_state debug: ' + (e.message || e.toString()), 'warn');
  }

  log("Extracting Subscriptions...");
  const subsRes = db.exec(`SELECT url, name, avatar_url FROM subscriptions WHERE service_id = ${SERVICE_ID_YOUTUBE}`);
  if (subsRes.length > 0) {
    const rows = subsRes[0].values;
    rows.forEach(row => {
      const url = row[0];
      if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
        log(`Dropped non-YouTube subscription URL: ${row[1]}`, "warn");
        return;
      }
      let channelId = "";
      const channelMatch = url.match(/channel\/([\w-]+)/);
      const userMatch = url.match(/user\/([\w-]+)/);
      if (channelMatch) channelId = channelMatch[1];
      else if (userMatch) channelId = userMatch[1];

      targetData.subscriptions.push({
        channelId: channelId,
        url: url,
        name: row[1],
        avatar: row[2],
        verified: false
      });
    });
  }
  log(`Extracted ${targetData.subscriptions.length} YouTube subscriptions.`);

  log("Extracting Remote Playlists...");
  const remPlRes = db.exec(`SELECT name, url, uploader, thumbnail_url, stream_count FROM remote_playlists WHERE service_id = ${SERVICE_ID_YOUTUBE}`);
  if (remPlRes.length > 0) {
    const rows = remPlRes[0].values;
    rows.forEach(row => {
      const url = row[1];
      if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
        log(`Dropped non-YouTube remote playlist URL: ${row[0]}`, "warn");
        return;
      }
      const idMatch = url.match(/[?&]list=([^&]+)/);
      const id = idMatch ? idMatch[1] : "";

      targetData.playlistBookmarks.push({
        playlistId: id,
        playlistName: row[0],
        thumbnailUrl: row[3],
        uploader: row[2],
        uploaderUrl: "",
        videos: row[4]
      });
    });
  }
  log(`Extracted ${targetData.playlistBookmarks.length} remote playlist bookmarks.`);

  log("Extracting Local Playlists...");
  const playlistsRes = db.exec("SELECT uid, name FROM playlists");
  if (playlistsRes.length > 0) {
    for (const plRow of playlistsRes[0].values) {
      const plId = plRow[0];
      const plName = plRow[1];
      const videos = [];
      const vidRes = db.exec(`
                    SELECT s.url, s.title, s.duration, s.uploader, s.upload_date, s.thumbnail_url
                    FROM playlist_stream_join j
                    JOIN streams s ON j.stream_id = s.uid
                    WHERE j.playlist_id = ${plId} AND s.service_id = ${SERVICE_ID_YOUTUBE}
                    ORDER BY j.join_index ASC
                `);

      if (vidRes.length > 0) {
        vidRes[0].values.forEach(v => {
          const vUrl = v[0];
          const vidIdMatch = vUrl.match(/v=([^&]+)/);
          const vidId = vidIdMatch ? vidIdMatch[1] : "";
          if (!vidId) {
            log(`Warning: Skipped stream in playlist "${plName}" due to unparseable URL: ${vUrl}`, "warn");
            return;
          }

          videos.push({
            id: vidId,
            playlistId: plId,
            videoId: vidId,
            title: v[1],
            uploadDate: v[4] ? new Date(v[4]*1000).toISOString().split('T')[0] : "1970-01-01",
            uploader: v[3],
            thumbnailUrl: v[5],
            duration: v[2]
          });
        });
      }

      if (videos.length > 0 || plName) {
        targetData.localPlaylists.push({
          playlist: {
            id: plId,
            name: plName,
            thumbnailUrl: videos.length > 0 ? videos[0].thumbnailUrl : ""
          },
          videos: videos
        });
      }
    }
  }
  log(`Extracted ${targetData.localPlaylists.length} local playlists.`);

  const jsonStr = JSON.stringify(targetData, null, 2);
  const blob = new Blob([jsonStr], {type: "application/json"});
  const timestamp = getTimestamp();
  downloadFile(blob, "libretube_converted.json", timestamp);
  log("Done! File downloaded.", "info");
}
