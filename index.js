// -- Imports
const http = require('node:http');
const WebSocketServer = require('websocket').server;
const Crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

// -- Classes
class ClientData {
  constructor(sessionID, synced, username, color) {
    this.sessionID = sessionID;
    this.synced = synced;
    this.username = username;
    this.color = color;
  }
}

class SessionData {
  constructor(code, creatorID) {
    this.code = code;
    this.creatorID = creatorID;
    this.clientIDs = [ creatorID ];
    this.syncing = false;
  }
}

// Properties are capitilized for easy interoperability with the MercuryMapper project naming conventions
class MessageFormat {
  constructor(messageType, stringData, intData, decimalData) {
    this.MessageType = messageType;
    this.StringData = stringData ?? [];
    this.IntData = intData ?? [];
    this.DecimalData = decimalData ?? [];
  }
}

// -- Global constant values
const SupportedVersions = [ '1.0.0', '1.0.1' ];
const ValidFileExtensions = [ '.wav', '.flac', '.ogg', '.mp3'];
const Port = 5390;
const ClientConnections = new Map();
const Clients = new Map();
const Sessions = new Map();

const WebPage = fs.readFileSync('./assets/index.html');
const WebIcon = fs.readFileSync('./assets/favicon.ico');
const WebIcon16 = fs.readFileSync('./assets/favicon-16x16.png');
const WebIcon32 = fs.readFileSync('./assets/favicon-32x32.png');

const CodeChars = 'ACDEFGHJKPRTUVWXYZ0123456789';

const MessageTypes = {
  // 000 - Connect, Host, Join, and Sync
  InitConnection: 0,
  OutdatedClient: 1,
  CreateSession: 2,
  SessionCreated: 3,
  SessionClosed: 4,
  JoinSession: 5,
  LeaveSession: 6,
  BadSessionCode: 7,
  GoodSessionCode: 8,
  SyncRequest: 9,
  File: 10,
  ChartData: 11,
  SyncBegin: 12,
  SyncEnd: 13,

  // 100 - Metadata
  VersionChange: 100,
  TitleChange: 101,
  RubiChange: 102,
  ArtistChange: 103,
  AuthorChange: 104,
  DiffChange: 105,
  LevelChange: 106,
  ClearThresholdChange: 107,
  BpmTextChange: 108,
  PreviewStartChange: 109,
  PreviewTimeChange: 110,
  BgmOffsetChange: 111,
  BgaOffsetChange: 112,
  BackgroundChange: 113,

  // 200 - Realtime Events
  InsertNote: 200,
  InsertHoldNote: 201,
  InsertHoldSegment: 202,
  DeleteNote: 203,
  DeleteHoldNote: 204,
  EditNote: 205,
  BakeHold: 206,
  SplitHold: 207,
  StitchHold: 208,
  InsertGimmick: 209,
  EditGimmick: 210,
  DeleteGimmick: 211,
  ClientTimestamp: 212
};

// -- Global changing values
let currentNewClientID = 0;
let currentNewSessionID = 0;
let logPath;

// -- Where it all starts
// Make log directory
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// Make new log file
const date = new Date();
logPath = `logs/${date.getMonth()}-${date.getDate()}-${date.getFullYear()}_${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}.log`;
fs.writeFileSync(logPath, '', 'utf-8');

// Create the base HTTP server and return 404 for unknown requests
const HTTPServer = http.createServer((req, res) => {
  const file = req.url.split('/').pop();
  
  switch(file) {
    case '':
    case 'index.html':
      res.setHeader('Content-Type', 'text/html');
      res.end(WebPage);
      break;
    case 'favicon.ico':
      res.setHeader('Content-Type', 'image/x-icon');
      res.end(WebIcon);
      break;
    case 'favicon-16x16.png':
      res.setHeader('Content-Type', 'image/png');
      res.end(WebIcon16);
      break;
    case 'favicon-32x32.png':
      res.setHeader('Content-Type', 'image/png');
      res.end(WebIcon32);
      break;
    case 'status':
      res.setHeader('Content-Type', 'application/json');
      res.end(getStatus());
      break;
    default:
      // Put a "/" onto the end of unknown URLs to force the index page
      res.writeHead(302, { Location: `${file}/` });
      res.end();
      break;
    }
});

// Have the HTTP server start listening
HTTPServer.listen(Port, () => {
  console.info(`MercuryMultiMapperServer listening on port ${Port}...`);
  logInfo(`MercuryMultiMapperServer started.`);
});

// Create WebSocket server instance
const WSServer = new WebSocketServer({
  httpServer: HTTPServer,
  autoAcceptConnections: false,
  maxReceivedFrameSize: 104857600, // 100 MB
  maxReceivedMessageSize: 104857600 // 100 MB
});

// Have WebSocket server start listening for WebSocket requests
WSServer.on('request', (request) => {
  if (!requestAllowed(request)) {
    logInfo(`Client IP '${conn.remoteAddress}' rejected.`);
    request.reject();
    return;
  }

  const conn = request.accept('mercury-multi-mapper', request.origin);

  // If we ever hit the limit of ints - I will be shocked - then add a check for it
  const clientID = currentNewClientID++;

  ClientConnections.set(clientID, conn);

  logInfo(`Client with IP '${conn.remoteAddress}' connected and assigned connection ID '${clientID}.'`);

  conn.on('message', (msg) => {
    if (msg.type !== 'utf8') {
      logInfo(`Client ID '${clientID}' sent bad data.`);
      closeClientConnection(clientID, 1003);
      return;
    }

    if (msg.utf8Data == '') {
      logInfo(`Client ID '${clientID}' sent an empty string.`);
      closeClientConnection(clientID, 1003);
      return;
    }

    handleEvent(clientID, msg);
  });

  conn.on('close', () => {
    logInfo(`Client ID '${clientID}' disconnected.`);

    checkSessionSyncStatus(clientID);

    const clientInfo = Clients.get(clientID);

    if (clientInfo) {
      const sessionInfo = Sessions.get(clientInfo.sessionID);
  
      if (sessionInfo) {
        if (clientID == sessionInfo.creatorID) {
          sendMessageOtherSessionClients(clientID, new MessageFormat(MessageTypes.SessionClosed));
    
          Sessions.delete(clientInfo.sessionID);
        } else {
          sendMessageOtherSessionClients(clientID, new MessageFormat(MessageTypes.LeaveSession, null, [ clientID ]));

          sessionInfo.clientIDs = sessionInfo.clientIDs.filter(id => id !== clientID);
        }
      }

      Clients.delete(clientID);
    }

    ClientConnections.delete(clientID);
  });
});

// -- Helper Functions

// TODO: Improve client verification to help prevent spam, but this should be good enough for now... (Watch this become forever... it probably will.)
// If you're reading this and it annoys you - feel free to send a PR to improve it.
function requestAllowed(request) {
  return request.httpRequest.headers['sec-websocket-protocol'] == 'mercury-multi-mapper';
}

function logInfo(log) {
  fs.appendFileSync(logPath, `${new Date()}: ${log}\n`, 'utf-8');
}

function closeClientConnection(clientID, code) {
  const clientConnection = ClientConnections.get(clientID);

  if (clientConnection) {
    clientConnection.close(code ?? 1000, "390: Chart editor not found.  This is a MercuryMultiMapperServer!");
  }
}

function getRandomIntInclusive(min, max) {
  const randomBuffer = new Uint32Array(1);

  Crypto.getRandomValues(randomBuffer);

  const randomNumber = randomBuffer[0] / (0xffffffff + 1);

  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(randomNumber * (max - min + 1)) + min;
}

function generateSessionCode() {
  let code = '';
  
  for (let i = 0; i < 8; i++) {
    const charIndex = getRandomIntInclusive(0, CodeChars.length - 1);
    code += CodeChars.substring(charIndex, charIndex + 1);
  }

  if (checkForDuplicateSessionCode(code)) {
    return generateSessionCode();
  }

  return code;
}

function sendMessage(clientID, messageData) {
  const clientConnection = ClientConnections.get(clientID);

  if (clientConnection) {
    clientConnection.send(JSON.stringify(messageData));
  }
}

function sendMessageSessionCreator(clientID, messageData) {
  const clientInfo = Clients.get(clientID);

  if (!clientInfo) {
    return;
  }

  const sessionInfo = Sessions.get(clientInfo.sessionID);
  const clientConnection = ClientConnections.get(sessionInfo.creatorID);

  if (clientConnection) {
    clientConnection.send(JSON.stringify(messageData));
  }
}

function sendMessageOtherSessionClients(clientID, messageData) {
  const clientInfo = Clients.get(clientID);

  if (!clientInfo || !clientInfo.sessionID) {
    return;
  }

  const sessionInfo = Sessions.get(clientInfo.sessionID);

  if (!sessionInfo) {
    return;
  }

  const otherClients = sessionInfo.clientIDs;
  
  otherClients.forEach(otherClientID => {
    if (clientID == otherClientID) return;
    
    const clientData = ClientConnections.get(otherClientID);

    if (clientData) {
      clientData.send(JSON.stringify(messageData));
    }
  });
}

function sendMessageSessionAll(sessionID, messageData) {
  const clients = Sessions.get(sessionID).clientIDs;
  
  clients.forEach(clientID => {
    const clientConnection = ClientConnections.get(clientID);

    if (clientConnection) {
      clientConnection.send(JSON.stringify(messageData));
    }
  });
}

function getSessionIdFromCode(code) {
  for (let [id, sessionData] of Sessions.entries()) {
    if (sessionData.code == code) {
      return id;
    }
  }
}

// This should have a stupid low chance of happening, but it can happen.
function checkForDuplicateSessionCode(code) {
  for (let [_, sessionData] of Sessions.entries()) {
    if (sessionData.code == code) {
      return true;
    }
  }
  return false;
}

function checkInvalidFileExtension(fileName) {
  for (let i = 0; i < ValidFileExtensions.length; i++) {
    if (fileName.endsWith(ValidFileExtensions[i])) {
      return false;
    }
  }

  return true;
}

function isSessionSynced(sendingClientSessionInfo) {
  for (let i = 0; i < sendingClientSessionInfo.clientIDs.length; i++) {
    const clientInfo = Clients.get(sendingClientSessionInfo.clientIDs[i]);

    if (clientInfo && !clientInfo.synced) {
      return false;
    }
  }

  return true;
}

function getStatus() {
  const res = {
    connections: ClientConnections.size,
    sessions: Sessions.size,
    clients: Clients.size,
    procUptime: process.uptime(),
    osUptime: os.uptime(),
    osCPU: os.loadavg(), // Hope you don't use Windows as your server OS :P
    osTotalRAM: os.totalmem(),
    osFreeRAM: os.freemem()
  };

  return JSON.stringify(res);
}

// -- Core Functions
function handleEvent(clientID, msg) {
  let incomingData;

  try {
    incomingData = JSON.parse(msg.utf8Data);
  } catch {
    logInfo(`Client ID '${clientID}' sent bad JSON!`);
    closeClientConnection(clientID, 1002);
    return;
  }

  if (isNaN(incomingData.MessageType)) {
    logInfo(`Client ID '${clientID}' didn't send a message type!`);
    closeClientConnection(clientID, 1003);
    return;
  }

  switch(incomingData.MessageType) {
    case MessageTypes.InitConnection:
      checkClientVersion(clientID, incomingData);
      return;
    case MessageTypes.CreateSession:
      createSession(clientID, incomingData);
      return;
    case MessageTypes.JoinSession:
      joinSession(clientID, incomingData);
      return;
    case MessageTypes.LeaveSession:
      leaveSession(clientID);
      return;
    case MessageTypes.SyncRequest:
      sendMessageSessionCreator(clientID, new MessageFormat(MessageTypes.SyncRequest, null, [ clientID ]));
      return;
    case MessageTypes.File:
    case MessageTypes.ChartData:
      relayFileOrChartData(clientID, incomingData);
      return;
    case MessageTypes.SyncEnd:
      checkSessionSyncStatus(clientID);
      return;
    case MessageTypes.VersionChange:
    case MessageTypes.TitleChange:
    case MessageTypes.RubiChange:
    case MessageTypes.ArtistChange:
    case MessageTypes.AuthorChange:
    case MessageTypes.DiffChange:
    case MessageTypes.LevelChange:
    case MessageTypes.ClearThresholdChange:
    case MessageTypes.BpmTextChange:
    case MessageTypes.PreviewStartChange:
    case MessageTypes.PreviewTimeChange:
    case MessageTypes.BgmOffsetChange:
    case MessageTypes.BgaOffsetChange:
    case MessageTypes.BackgroundChange:
    case MessageTypes.InsertNote:
    case MessageTypes.InsertHoldNote:
    case MessageTypes.InsertHoldSegment:
    case MessageTypes.DeleteNote:
    case MessageTypes.DeleteHoldNote:
    case MessageTypes.EditNote:
    case MessageTypes.BakeHold:
    case MessageTypes.SplitHold:
    case MessageTypes.StitchHold:
    case MessageTypes.InsertGimmick:
    case MessageTypes.EditGimmick:
    case MessageTypes.DeleteGimmick:
      sendMessageOtherSessionClients(clientID, incomingData);
      return;
    case MessageTypes.ClientTimestamp:
      incomingData.IntData.unshift(clientID);
      sendMessageOtherSessionClients(clientID, incomingData);
      return;
    default:
      logInfo(`Client ID '${clientID}' sent unsupported request ID '${incomingData.MessageType}.'`);
      return;
  }
}

function checkClientVersion(clientID, incomingData) {
  if (!incomingData.StringData || incomingData.StringData.length < 2 || incomingData.StringData[0] != 'Hello MercuryMultiMapperServer!') {
    logInfo(`Client ID '${clientID}' failed the version check!`);
    closeClientConnection(clientID, 1003);
    return;
  }

  if (SupportedVersions.includes(incomingData.StringData[1])) {
    logInfo(`Client ID '${clientID}' sent welcome message and has a good version, sending reply.`);
    sendMessage(clientID, new MessageFormat(MessageTypes.InitConnection, [ 'Hello MercuryMapper Client!' ]));
  } else {
    logInfo(`Client ID '${clientID}' has a bad version.`);
    sendMessage(clientID, new MessageFormat(MessageTypes.OutdatedClient));
    closeClientConnection(clientID, 1003);
  }
}

function createSession(clientID, incomingData) {
  const code = generateSessionCode();
  // If we ever hit the limit of ints - I will be shocked - then add a check for it
  const newSessionID = currentNewSessionID++;

  const clientData = new ClientData(newSessionID, true, incomingData.StringData[0], incomingData.StringData[1]);

  Clients.set(clientID, clientData);

  const sessionData = new SessionData(code, clientID);

  Sessions.set(newSessionID, sessionData);

  logInfo(`Client ID '${clientID}' created session ID '${newSessionID}' and code '${code}' using username '${clientData.username}' and color '${clientData.color}.'`);

  sendMessage(clientID, new MessageFormat(MessageTypes.SessionCreated, [ code ]));
}

function joinSession(clientID, incomingData) {
  const sessionID = getSessionIdFromCode(incomingData.StringData[0]);

  if (sessionID == null) {
    logInfo(`Client ID '${clientID}' sent invalid session code '${incomingData.StringData[0]}.`);
    sendMessage(clientID, new MessageFormat(MessageTypes.BadSessionCode));
    return;
  }

  const clientData = new ClientData(sessionID, false, incomingData.StringData[1], incomingData.StringData[2]);

  Clients.set(clientID, clientData);

  const sessionData = Sessions.get(sessionID);

  sendMessage(clientID, new MessageFormat(MessageTypes.GoodSessionCode));

  sessionData.clientIDs.forEach(sessionClientID => {
    sendMessage(sessionClientID, new MessageFormat(MessageTypes.JoinSession, [ clientData.username, clientData.color ], [ clientID ]));

    const existingClient = Clients.get(sessionClientID);

    if (existingClient) {
      sendMessage(clientID, new MessageFormat(MessageTypes.JoinSession, [ existingClient.username, existingClient.color ], [ sessionClientID ]));
    }
  });

  sessionData.clientIDs.push(clientID);

  if (!sessionData.syncing) {
    sessionData.syncing = true;
    sendMessageSessionAll(sessionID, new MessageFormat(MessageTypes.SyncBegin));
  }

  logInfo(`Client ID '${clientID}' joined session ID '${sessionID}' using username '${clientData.username}' and color '${clientData.color}.'`);
}

function leaveSession(clientID) {
  // Currently unused other than logging as users fully disconnect from server and that fires a leave message
  logInfo(`Client ID '${clientID}' left their session.'`);
}

function relayFileOrChartData(sendingClientID, incomingData) {
  const sendingClientInfo = Clients.get(sendingClientID);
  const sendingClientSessionInfo = Sessions.get(sendingClientInfo.sessionID);

  if (!sendingClientSessionInfo) {
    logInfo(`Client ID '${sendingClientID}' tried to send a file type to client ID '${receivingClientID}' without being in a session!`);
    closeClientConnection(sendingClientID);
    return;
  }

  const receivingClientID = incomingData.IntData[0];
  incomingData.IntData = [];

  if (incomingData.StringData.length > 1 && checkInvalidFileExtension(incomingData.StringData[0])) {
    logInfo(`Client ID '${sendingClientID}' tried to send an invalid file type to client ID '${receivingClientID}!'`);
    closeClientConnection(sendingClientID);
    return;
  }

  if (!sendingClientSessionInfo.clientIDs.includes(receivingClientID)) {
    logInfo(`Client ID '${sendingClientID}' tried to send file/chart to client ID '${receivingClientID}' without being in the session!`);
    closeClientConnection(sendingClientID);
    return;
  }

  sendMessage(receivingClientID, incomingData);
}

function checkSessionSyncStatus(clientID) {
  const sendingClientInfo = Clients.get(clientID);

  if (!sendingClientInfo) return;

  const sessionInfo = Sessions.get(sendingClientInfo.sessionID);

  if (!sessionInfo) return;
  
  if (sendingClientInfo.synced) return;

  if (!sessionInfo.syncing) return;

  sendingClientInfo.synced = true;

  if (isSessionSynced(sessionInfo)) {
    sessionInfo.syncing = false;
    sendMessageSessionAll(sendingClientInfo.sessionID, new MessageFormat(MessageTypes.SyncEnd));
  }
}
