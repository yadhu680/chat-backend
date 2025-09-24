// server.js
// Run: node server.js
// npm install ws uuid

const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Data stores
// usernameLower -> { id, username, ws (or null), online:boolean }
const usersByLower = new Map();
// id -> lowerUsername (for reverse lookup)
const idToLower = new Map();
// chat history (last N messages). Each message:
// {
//   id, userId, username, text, cleanText, private:bool, targets: [userIds], targetsUsernames:[], timestamp, readBy: [userIds]
// }
const chatHistory = [];
const MAX_HISTORY = 200;

// Extend badWords as needed
const badWords = [
  'asshole',
  'porn',
  'sex',
  'sexy',
  'scoundrel',
  'fucker',
  'idiot',
  'stupid',
  'dumb',
  'nonsense',
  'ugly',
  'fool',
  'shit',
  'fuck',
  'bitch',
  'bastard',
  'crap',
];

function filterBadWords(text) {
  if (!text) return '';
  let out = text;
  for (const w of badWords) {
    const rx = new RegExp(`\\b${w}\\b`, 'gi');
    out = out.replace(rx, '***');
  }
  return out;
}

function lower(s) {
  return (s || '').toLowerCase();
}

function buildOnlineList() {
  // returns array of { id, username, online }
  const arr = [];
  for (const [lowerName, info] of usersByLower.entries()) {
    arr.push({ id: info.id, username: info.username, online: !!info.ws });
  }
  return arr;
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore send errors
  }
}

// When a user connects/registers, we send them the chat history they are allowed to see:
// - public messages
// - private messages where they are sender or in targets
function getVisibleHistoryForUser(userIdLower) {
  const visible = [];
  for (const m of chatHistory) {
    if (!m.private) {
      visible.push({
        id: m.id,
        userId: m.userId,
        user:
          m.username === usersByLower.get(userIdLower)?.username
            ? 'You'
            : m.username,
        text: m.text,
        private: false,
        timestamp: m.timestamp,
        readBy: m.readBy,
      });
    } else {
      // private: show only if viewer is sender or in targets
      const lowerViewer = userIdLower;
      const isSenderLower = lower(m.username) === lowerViewer;
      const isTarget = m.targetsLower.includes(lowerViewer);
      if (isSenderLower) {
        // sender sees original (filtered for profanity) with mentions preserved (server filters profanity earlier)
        visible.push({
          id: m.id,
          userId: m.userId,
          user: 'You',
          text: m.originalText,
          private: true,
          timestamp: m.timestamp,
          readBy: m.readBy,
          targets: m.targetsUsernames,
          self: true,
        });
      } else if (isTarget) {
        // target sees text with mentions stripped (cleanText)
        visible.push({
          id: m.id,
          userId: m.userId,
          user: m.username,
          text: m.cleanText,
          private: true,
          timestamp: m.timestamp,
          readBy: m.readBy,
          targets: m.targetsUsernames,
        });
      }
    }
  }
  return visible;
}

// Mark message read, notify original sender if needed
function handleReadReceipt(readerId, messageId) {
  const msg = chatHistory.find((m) => m.id === messageId);
  if (!msg) return;
  if (!msg.readBy.includes(readerId)) {
    msg.readBy.push(readerId);
  }
  // notify sender (if online)
  const senderLower = lower(msg.username);
  const senderInfo = usersByLower.get(senderLower);
  if (
    senderInfo &&
    senderInfo.ws &&
    senderInfo.ws.readyState === WebSocket.OPEN
  ) {
    send(senderInfo.ws, {
      type: 'read',
      messageId: msg.id,
      readerId,
      readBy: msg.readBy.slice(),
    });
  }
}

// WebSocket handling
wss.on('connection', (ws) => {
  // each ws will receive a 'register' message first from client:
  // { type: 'register', desiredUsername: 'Alice' }
  let thisLower = null; // lower username for this socket

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // ignore invalid json
      return;
    }

    const t = data.type;

    // REGISTER: client requests a username
    // server responds with { type:'registered', id, username } (username may be adjusted to ensure uniqueness)
    if (t === 'register') {
      let desired = String(data.username || '').trim();
      if (!desired) {
        send(ws, { type: 'error', message: 'Username required' });
        return;
      }

      // ensure uniqueness: if desired already exists and is online, append suffix
      let candidate = desired;
      let suffix = 1;
      while (
        usersByLower.has(lower(candidate)) &&
        usersByLower.get(lower(candidate)).ws
      ) {
        candidate = `${desired}#${suffix++}`;
      }

      const assigned = candidate;
      const assignedLower = lower(assigned);
      const id = usersByLower.has(assignedLower)
        ? usersByLower.get(assignedLower).id
        : uuidv4();

      // set user entry with ws
      usersByLower.set(assignedLower, { id, username: assigned, ws });
      idToLower.set(id, assignedLower);
      thisLower = assignedLower;

      // send confirmation
      send(ws, { type: 'registered', id, username: assigned });

      // send visible history
      const visible = getVisibleHistoryForUser(assignedLower);
      send(ws, { type: 'history', messages: visible });

      // broadcast user list update
      const list = buildOnlineList();
      const payload = { type: 'users', users: list };
      for (const [l, info] of usersByLower.entries()) {
        if (info.ws && info.ws.readyState === WebSocket.OPEN)
          send(info.ws, payload);
      }

      return;
    }

    // LOGOUT
    if (t === 'logout') {
      if (thisLower && usersByLower.has(thisLower)) {
        const info = usersByLower.get(thisLower);
        info.ws = null;
        usersByLower.set(thisLower, info);
      }
      // broadcast user list
      const list2 = buildOnlineList();
      const payload2 = { type: 'users', users: list2 };
      for (const [l, info] of usersByLower.entries()) {
        if (info.ws && info.ws.readyState === WebSocket.OPEN)
          send(info.ws, payload2);
      }
      // close socket
      try {
        ws.close();
      } catch {}
      return;
    }

    // MESSAGE
    if (t === 'message') {
      // Must be registered
      if (!thisLower || !usersByLower.has(thisLower)) {
        send(ws, { type: 'error', message: 'Not registered' });
        return;
      }

      const senderInfo = usersByLower.get(thisLower);
      const senderId = senderInfo.id;
      const senderName = senderInfo.username;
      const rawText = String(data.text || '');
      const filteredText = filterBadWords(rawText);
      const timestamp = new Date().toISOString();
      const msgId = uuidv4();

      // find mentions (all @username tokens)
      const mentions = [...filteredText.matchAll(/@(\w+)/gi)].map((m) => m[1]);
      const mentionsLower = mentions.map((m) => lower(m));
      const uniqueLowerTargets = [...new Set(mentionsLower)];

      if (uniqueLowerTargets.length > 0) {
        // translate mention lowers into target info (id, username) if present
        const targets = [];
        const targetsUsernames = [];
        const targetsLowerExisting = [];
        for (const tl of uniqueLowerTargets) {
          if (usersByLower.has(tl)) {
            const info = usersByLower.get(tl);
            targets.push(info.id);
            targetsUsernames.push(info.username);
            targetsLowerExisting.push(tl);
          }
        }

        // Build history entry (private)
        const hist = {
          id: msgId,
          userId: senderId,
          username: senderName,
          originalText: filteredText, // sender sees filtered text (bad words replaced) including mentions
          cleanText: filteredText.replace(/@\w+\b\s*/gi, '').trim(), // for recipients
          private: true,
          targets: targets.slice(), // ids
          targetsUsernames: targetsUsernames.slice(),
          targetsLower: targetsLowerExisting.slice(),
          timestamp,
          readBy: [], // initially nobody read (not even sender)
        };

        chatHistory.push(hist);
        if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

        // deliver to online targets
        let deliveredSomeone = false;
        for (const tl of hist.targetsLower) {
          const info = usersByLower.get(tl);
          if (info && info.ws && info.ws.readyState === WebSocket.OPEN) {
            // recipient receives clean text with mention removed
            send(info.ws, {
              type: 'message',
              id: hist.id,
              userId: hist.userId,
              user: hist.username,
              text: hist.cleanText,
              private: true,
              targets: hist.targetsUsernames,
              timestamp: hist.timestamp,
            });
            deliveredSomeone = true;
          }
        }

        // always echo back to sender with original filtered text and self:true
        send(ws, {
          type: 'message',
          id: hist.id,
          userId: hist.userId,
          user: 'You',
          text: hist.originalText,
          private: true,
          self: true,
          targets: hist.targetsUsernames,
          timestamp: hist.timestamp,
        });

        // if none of targets online, optionally notify sender
        if (!deliveredSomeone) {
          send(ws, {
            type: 'system',
            text: 'None of the mentioned users were online. Message saved to history.',
            timestamp,
          });
        }

        return;
      }

      // PUBLIC message: broadcast to everyone (sender will also receive it, server will send user=senderName; client will display You locally)
      const histPub = {
        id: msgId,
        userId: senderId,
        username: senderName,
        text: filteredText,
        private: false,
        targets: [],
        targetsUsernames: [],
        targetsLower: [],
        timestamp,
        readBy: [senderId],
      };
      chatHistory.push(histPub);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();

      // send to all online users
      for (const [l, info] of usersByLower.entries()) {
        if (info.ws && info.ws.readyState === WebSocket.OPEN) {
          // For all clients we send the same payload; client will interpret user === their username as You
          send(info.ws, {
            type: 'message',
            id: histPub.id,
            userId: histPub.userId,
            user: histPub.username,
            text: histPub.text,
            private: false,
            timestamp: histPub.timestamp,
          });
        }
      }
      return;
    }

    // READ receipt: { type:'read', messageId, readerId }
    if (t === 'read') {
      const readerId = data.readerId;
      const messageId = data.messageId;
      if (!readerId || !messageId) return;
      const histMsg = chatHistory.find((m) => m.id === messageId);
      if (!histMsg) return;
      if (!histMsg.readBy.includes(readerId)) histMsg.readBy.push(readerId);

      // notify original sender (if online)
      const senderLower = lower(histMsg.username);
      const senderInfo = usersByLower.get(senderLower);
      if (
        senderInfo &&
        senderInfo.ws &&
        senderInfo.ws.readyState === WebSocket.OPEN
      ) {
        send(senderInfo.ws, {
          type: 'read',
          messageId: histMsg.id,
          readerId,
          readBy: histMsg.readBy.slice(),
        });
      }
      return;
    }
  });

  ws.on('close', () => {
    // mark user offline if present
    for (const [l, info] of usersByLower.entries()) {
      if (info.ws === ws) {
        usersByLower.set(l, { id: info.id, username: info.username, ws: null });
        break;
      }
    }
    // broadcast updated list
    const list = buildOnlineList();
    const payload = { type: 'users', users: list };
    for (const [l, info] of usersByLower.entries()) {
      if (info.ws && info.ws.readyState === WebSocket.OPEN)
        send(info.ws, payload);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server listening on PORT: ${PORT}`);
});
