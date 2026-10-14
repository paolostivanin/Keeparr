// The realtime channel: connected sockets per user, who is viewing which note, and the broadcasts the rest of the
// server calls after a change. Inside a transaction a broadcast waits for the commit.
const { WebSocket, WebSocketServer } = require('ws');
const { get, all, currentTransaction } = require('./db');
const { mcpTokenHash, redeemRealtimeTicket } = require('./auth');

const realtimeClients = new Map();

function addRealtimeClient(userId, socket, sessionHash = '') {
  socket.sessionHash = sessionHash;
  if (!realtimeClients.has(userId)) {
    realtimeClients.set(userId, new Set());
    broadcastRealtimeToAll({ type: 'global-presence', userId, online: true });
  }
  realtimeClients.get(userId).add(socket);
  socket.on('close', () => {
    const sockets = realtimeClients.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (!sockets.size) {
      realtimeClients.delete(userId);
      broadcastRealtimeToAll({ type: 'global-presence', userId, online: false });
    }
  });
}

// With `exceptSessionHash`, the sockets of that session stay open (the device that just changed its password).
function closeRealtimeClientsForUser(userId, reason = 'Account disabled.', exceptSessionHash = '') {
  const sockets = realtimeClients.get(userId);
  if (!sockets) return;
  for (const socket of [...sockets]) {
    if (exceptSessionHash && socket.sessionHash === exceptSessionHash) continue;
    try {
      socket.close(1008, reason);
    } catch {}
    sockets.delete(socket);
  }
  if (!sockets.size) {
    realtimeClients.delete(userId);
    broadcastRealtimeToAll({ type: 'global-presence', userId, online: false });
  }
}

function broadcastRealtime(userIds, payload) {
  const transaction = currentTransaction();
  if (transaction?.active) {
    const recipients = [...(userIds || [])];
    const message = { ...payload };
    transaction.afterCommit.push(() => broadcastRealtime(recipients, message));
    return;
  }
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  const message = JSON.stringify({ ...payload, at: new Date().toISOString() });

  uniqueUserIds.forEach(userId => {
    const sockets = realtimeClients.get(userId);
    if (!sockets) return;
    sockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    });
  });
}

function broadcastRealtimeToAll(data) {
  const message = JSON.stringify({ ...data, at: new Date().toISOString() });
  realtimeClients.forEach((sockets) => {
    sockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    });
  });
}

const notePresence = new Map();
const socketPresence = new Map();

async function broadcastPresenceUpdate(noteId, getNoteRecipientIds) {
  const activeUserIds = Array.from(notePresence.get(noteId) || []);
  let activeEditors = [];
  if (activeUserIds.length > 0) {
    const placeholders = activeUserIds.map(() => '?').join(',');
    activeEditors = await all(
      `SELECT id, username, displayName, avatarDataUrl, avatarPreset
       FROM users WHERE id IN (${placeholders})`,
      activeUserIds
    );
  }
  const recipients = await getNoteRecipientIds(noteId);
  broadcastRealtime(recipients, { type: 'presence-update', noteId, activeEditors });
}

let wss;
function setupRealtime({ server, getAccessibleNote, getNoteRecipientIds }) {
  const presenceUpdate = noteId => broadcastPresenceUpdate(noteId, getNoteRecipientIds);
  wss = new WebSocketServer({ server, path: '/api/realtime', maxPayload: 64 * 1024 });

  wss.on('connection', async (socket, req) => {
    // Attached before anything is awaited: an unhandled 'error' event (a malformed frame, say) would end the process.
    socket.on('error', error => console.error('Realtime socket error', error?.message || error));
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] || '';
      // The Authorization header (native clients) or a single-use ticket from POST /api/realtime/ticket (browsers).
      const sessionHash = bearer ? mcpTokenHash(bearer) : redeemRealtimeTicket(url.searchParams.get('ticket'))?.sessionHash || '';
      const session = sessionHash ? await get(
        `SELECT users.* FROM sessions
         JOIN users ON users.id = sessions.userId
         WHERE sessions.token = ? AND users.enabled = 1
           AND (sessions.expiresAt IS NULL OR sessions.expiresAt > ?)`,
        [sessionHash, new Date().toISOString()]
      ) : null;

      if (!session) {
        socket.close(1008, 'Authentication required.');
        return;
      }

      addRealtimeClient(session.id, socket, sessionHash);

      socket.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'join-note') {
            const noteId = Number(msg.noteId);
            if (!Number.isFinite(noteId) || noteId <= 0) return;
            // Only allow presence join for notes the user actually has access to.
            // Without this, anyone could enumerate note ids and broadcast their
            // presence to every collaborator on those notes.
            const accessible = await getAccessibleNote(noteId, session.id);
            if (!accessible) return;
            socketPresence.set(socket, noteId);
            if (!notePresence.has(noteId)) notePresence.set(noteId, new Set());
            notePresence.get(noteId).add(session.id);
            await presenceUpdate(noteId);
          } else if (msg.type === 'leave-note') {
            const noteId = msg.noteId;
            socketPresence.delete(socket);
            if (notePresence.has(noteId)) {
              notePresence.get(noteId).delete(session.id);
              if (notePresence.get(noteId).size === 0) notePresence.delete(noteId);
              await presenceUpdate(noteId);
            }
          }
        } catch (e) {
          console.error('Invalid WS message', e);
        }
      });

      socket.on('close', async () => {
       try {
        const socketsForUser = realtimeClients.get(session.id);
        if (socketsForUser) {
          socketsForUser.delete(socket);
          if (socketsForUser.size === 0) {
            realtimeClients.delete(session.id);
            broadcastRealtimeToAll({ type: 'global-presence', userId: session.id, online: false });
          }
        }
        const noteId = socketPresence.get(socket);
        if (noteId) {
          socketPresence.delete(socket);
          if (notePresence.has(noteId)) {
            notePresence.get(noteId).delete(session.id);
            if (notePresence.get(noteId).size === 0) notePresence.delete(noteId);
            await presenceUpdate(noteId);
          }
        }
       } catch (error) {
        console.error('Realtime close handling failed', error?.message || error);
       }
      });

      socket.send(JSON.stringify({ type: 'ready', at: new Date().toISOString() }));
    } catch (error) {
      console.error(error);
      socket.close(1011, 'Realtime setup failed.');
    }
  });
}

function terminateRealtimeClients() {
  try { wss?.clients?.forEach(client => client.terminate()); } catch {}
}

module.exports = {
  realtimeClients, closeRealtimeClientsForUser, broadcastRealtime, setupRealtime,
  terminateRealtimeClients
};
