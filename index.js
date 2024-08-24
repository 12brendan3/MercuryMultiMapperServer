// -- Imports
const http = require('http');
const WebSocketServer = require('websocket').server;
const Crypto = require('node:crypto');

// -- Classes
class ClientData {
  constructor(sessionID, username, color) {
    this.sessionID = sessionID;
    this.username = username;
    this.color = color;
  }
}

class SessionData {
  constructor(code, name, creatorID) {
    this.code = code;
    this.name = name;
    this.creatorID = creatorID;
    this.clientIDs = [ creatorID ];
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
const SupportedVersions = [ 'v3.0.0', 'v3.0.0 DEV' ];
const ValidFileExtensions = [ '.wav', '.flac', '.ogg', '.mp3'];
const Port = 5390;
const ClientConnections = new Map();
const Clients = new Map();
const Sessions = new Map();

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
  SyncDone: 12,

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

// Create the base HTTP server and return 418 for standard requests
const HTTPServer = http.createServer((req, res) => {
  logInfo(`Client with IP '${req.headers['x-forwarded-for'] ?? req.socket.remoteAddress}' tried regular HTTP request, replied with 418.`);
  res.writeHead(418, { 'Content-Type': 'text/plain'});
  res.write('390: Chart editor not found.  This is a MercuryMultiMapperServer!');
  res.end();
});

// Have the HTTP server start listening
HTTPServer.listen(Port, () => {
  logInfo(`MercuryMultiMapper listening on port ${Port}...`);
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
      closeClientConnection(clientID, 1002);
      return;
    }

    handleEvent(clientID, msg);
  });

  conn.on('close', () => {
    logInfo(`Client ID '${clientID}' disconnected.`);
    
    const clientInfo = Clients.get(clientID);

    if (clientInfo) {
      const sessionInfo = Sessions.get(clientInfo.sessionID);
  
      if (sessionInfo) {
        if (clientID == sessionInfo.creatorID) {
          sendMessageOtherClients(clientID, new MessageFormat(MessageTypes.SessionClosed));
    
          Sessions.delete(clientInfo.sessionID);
        } else {
          sendMessageOtherClients(clientID, new MessageFormat(MessageTypes.LeaveSession, null, [ clientID ]));

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
  console.info(`${new Date()}: ${log}`);
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

function sendMessageOtherClients(clientID, messageData) {
  const clientInfo = Clients.get(clientID);

  if (!clientInfo) {
    return;
  }

  const otherClients = Sessions.get(clientInfo.sessionID).clientIDs;
  
  otherClients.forEach(otherClientID => {
    if (clientID == otherClientID) return;
    
    const clientData = ClientConnections.get(otherClientID);

    if (clientData) {
      clientData.send(JSON.stringify(messageData));
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
    case MessageTypes.SyncDone:
      sendMessageSessionCreator(clientID, new MessageFormat(MessageTypes.SyncDone, null, [ clientID ]));
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
      sendMessageOtherClients(clientID, incomingData);
      return;
    case MessageTypes.ClientTimestamp:
      incomingData.IntData.unshift(clientID);
      sendMessageOtherClients(clientID, incomingData);
      return;
    default:
      logInfo(`Client ID '${clientID}' sent unsupported request ID '${incomingData.MessageType}.'`);
      return;
  }
}

function checkClientVersion(clientID, incomingData) {
  if (!incomingData.StringData || incomingData.StringData.length < 2 || incomingData.StringData[0] != 'Hello MercuryMultiMapperServer!') {
    logInfo(`Client ID '${clientID}' failed the version check!`);
    closeClientConnection(clientID, 3003);
    return;
  }

  if (SupportedVersions.includes(incomingData.StringData[1])) {
    logInfo(`Client ID '${clientID}' sent welcome message and has a good version, sending reply.`);
    sendMessage(clientID, new MessageFormat(MessageTypes.InitConnection, [ 'Hello MercuryMapper Client!' ]));
  }
}

function createSession(clientID, incomingData) {
  const code = generateSessionCode();
  const newSessionID = currentNewSessionID++;

  const clientData = new ClientData(newSessionID, incomingData.StringData[0], incomingData.StringData[1]);

  Clients.set(clientID, clientData);

  const sessionData = new SessionData(code, 'No Name', clientID);

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

  const clientData = new ClientData(sessionID, incomingData.StringData[1], incomingData.StringData[2]);

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

  logInfo(`Client ID '${clientID}' joined session ID '${sessionID}' using username '${clientData.username}' and color '${clientData.color}.'`);
}

function leaveSession(clientID) {
  // Currently unused other than logging as users fully disconnect from server and that fires a leave message
  logInfo(`Client ID '${clientID}' left their session.'`);
}

function relayFileOrChartData(sendingClientID, incomingData) {
  const sendingClientInfo = Clients.get(sendingClientID);
  const sendingClientSessionInfo = Sessions.get(sendingClientInfo.sessionID);

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