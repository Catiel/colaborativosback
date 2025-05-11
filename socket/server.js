const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = 3002;
const RECONNECTION_WINDOW = 10000;
const MESSAGE_STATUS = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  ERROR: 'error'
};

const rooms = new Map();
const recentDisconnections = new Map();
const roomMessages = new Map();
const roomParticipants = new Map();
const userJoinTimestamps = new Map();

const wss = new WebSocket.Server({ port: PORT });
console.log(`Servidor WebSocket iniciado en el puerto ${PORT}`);

function getRoomIfExists(roomCode) {
  return rooms.get(roomCode);
}

function createRoom(roomCode) {
  const room = {
    users: new Map(),
    userCount: 0
  };
  rooms.set(roomCode, room);
  roomMessages.set(roomCode, []);
  roomParticipants.set(roomCode, new Map());
  return room;
}

function removeUserFromRoom(roomCode, displayName, isVoluntary) {
  if (!rooms.has(roomCode)) return false;
  
  const room = rooms.get(roomCode);
  if (!room.users.has(displayName)) return false;
  
  room.users.delete(displayName);
  room.userCount--;
  
  if (isVoluntary) {
    if (roomParticipants.has(roomCode)) {
      roomParticipants.get(roomCode).delete(displayName);
    }
    
    const userRoomKey = `${displayName}_${roomCode}`;
    if (userJoinTimestamps.has(userRoomKey)) {
      userJoinTimestamps.delete(userRoomKey);
    }
    
    addNotificationToHistory(roomCode, `${displayName} ha abandonado la sala.`);
  } else {
    if (roomParticipants.has(roomCode) && roomParticipants.get(roomCode).has(displayName)) {
      const participant = roomParticipants.get(roomCode).get(displayName);
      participant.connected = false;
      participant.status = "desconectado";
      participant.lastSeen = Date.now();
    }
  }
  
  return true;
}

function cleanupEmptyRoom(roomCode) {
  if (!rooms.has(roomCode)) return;
  
  const room = rooms.get(roomCode);
  if (room.userCount > 0) return;
  
  const hasMessages = roomMessages.has(roomCode) && roomMessages.get(roomCode).length > 0;
  
  if (!hasMessages) {
    rooms.delete(roomCode);
    roomMessages.delete(roomCode);
    roomParticipants.delete(roomCode);
    console.log(`Sala ${roomCode} eliminada por no tener usuarios ni historial`);
  } else {
    console.log(`Sala ${roomCode} mantenida con ${roomMessages.get(roomCode).length} mensajes en historial`);
  }
}

function getUserDisplayName(message) {
  return message.displayName || message.userName.split('_')[0];
}

function trackUserConnection(roomCode, displayName) {
  const userRoomKey = `${displayName}_${roomCode}`;
  const isFirstTimeJoining = !userJoinTimestamps.has(userRoomKey);
  const hadLeftVoluntarily = roomParticipants.has(roomCode) && 
                           roomParticipants.get(roomCode).has(displayName) && 
                           !userJoinTimestamps.has(userRoomKey);
  
  if (isFirstTimeJoining || hadLeftVoluntarily) {
    const joinTimestamp = Date.now();
    userJoinTimestamps.set(userRoomKey, joinTimestamp);
    console.log(`Usuario ${displayName} se unió ${isFirstTimeJoining ? 'por primera vez' : 'de nuevo'} a la sala ${roomCode} en ${new Date(joinTimestamp).toLocaleString()}`);
    return { isFirstTimeJoining, hadLeftVoluntarily, joinTimestamp };
  }
  
  return { isFirstTimeJoining, hadLeftVoluntarily, joinTimestamp: userJoinTimestamps.get(userRoomKey) };
}

function updateUserStatus(roomCode, displayName, status, lastActivity = Date.now()) {
  if (!rooms.has(roomCode)) return;
  
  const room = rooms.get(roomCode);
  if (room.users.has(displayName)) {
    const userInfo = room.users.get(displayName);
    userInfo.status = status;
    userInfo.lastActivity = lastActivity;
  }
  
  if (roomParticipants.has(roomCode) && roomParticipants.get(roomCode).has(displayName)) {
    const participant = roomParticipants.get(roomCode).get(displayName);
    participant.status = status;
    participant.lastSeen = lastActivity;
  }
}

function addNotificationToHistory(roomCode, content) {
  if (!roomMessages.has(roomCode)) return;
  
  const timestamp = Date.now();
  roomMessages.get(roomCode).push({
    type: 'notification',
    timestamp,
    content
  });
  
  return timestamp;
}

function createChatMessage(roomCode, sender, content) {
  const now = new Date();
  const timestamp = now.getTime();
  const time = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const messageId = `msg_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;
  const formattedMessage = `${sender} [${time}]: ${content}`;
  
  if (roomMessages.has(roomCode)) {
    roomMessages.get(roomCode).push({
      id: messageId,
      type: 'chat',
      sender,
      timestamp,
      content,
      formattedContent: formattedMessage,
      status: MESSAGE_STATUS.DELIVERED
    });
  }
  
  return { messageId, timestamp, formattedMessage };
}

function broadcastToRoom(roomCode, messageObj) {
  if (!rooms.has(roomCode)) return;
  
  const room = rooms.get(roomCode);
  const messageString = JSON.stringify(messageObj);
  
  room.users.forEach(userInfo => {
    userInfo.sockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(messageString);
      }
    });
  });
}

function sendRecentMessageHistory(socket, roomCode, displayName) {
  if (!roomMessages.has(roomCode) || !displayName) return;
  
  const messages = roomMessages.get(roomCode);
  if (messages.length === 0) return;
  
  const userRoomKey = `${displayName}_${roomCode}`;
  const userJoinTime = userJoinTimestamps.get(userRoomKey);
  
  if (!userJoinTime) {
    console.log(`${displayName} se está uniendo como nuevo usuario a la sala ${roomCode}, no se envía historial`);
    return;
  }
  
  const relevantMessages = messages.filter(msg => msg.timestamp >= userJoinTime);
  
  if (relevantMessages.length > 0) {
    console.log(`Enviando ${relevantMessages.length} mensajes del historial a ${displayName} (desde ${new Date(userJoinTime).toLocaleString()})`);
    socket.send(JSON.stringify({
      type: 'messageHistory',
      roomCode,
      messages: relevantMessages
    }));
  } else {
    console.log(`No hay mensajes relevantes para enviar a ${displayName} (se unió en ${new Date(userJoinTime).toLocaleString()})`);
  }
}

function updateUserList(roomCode) {
  if (!rooms.has(roomCode)) return;
  
  const room = rooms.get(roomCode);
  const userList = [];
  let connectedCount = 0;
  
  room.users.forEach((userInfo, userName) => {
    let displayStatus = userInfo.status;
    if (!userInfo.connected) {
      displayStatus = "desconectado";
    } else {
      connectedCount++;
    }
    
    userList.push({
      name: userName,
      status: displayStatus,
      typing: userInfo.typing,
      connected: userInfo.connected,
      lastActivity: userInfo.lastActivity
    });
  });
  
  if (roomParticipants.has(roomCode)) {
    roomParticipants.get(roomCode).forEach((participantInfo, participantName) => {
      if (!room.users.has(participantName)) {
        userList.push({
          name: participantName,
          status: "desconectado",
          typing: false,
          connected: false,
          lastActivity: participantInfo.lastSeen || Date.now()
        });
      }
    });
  }
  
  console.log(`Actualizando lista de usuarios en sala ${roomCode}: ${userList.map(u => u.name).join(', ')}`);
  
  broadcastToRoom(roomCode, {
    type: 'userList',
    roomCode,
    count: room.userCount,
    activeCount: connectedCount,
    users: userList
  });
}

function broadcastTypingStatus(roomCode, userName, isTyping) {
  broadcastToRoom(roomCode, {
    type: 'typingStatus',
    roomCode,
    userName,
    isTyping
  });
}

function handleJoinRoom(socket, message, socketState) {
  const roomCode = message.roomCode;
  const userName = message.userName;
  const displayName = getUserDisplayName(message);
  
  const salaExistente = rooms.has(roomCode);
  
  if (!salaExistente) {
    const isFirstRoomCreator = !roomParticipants.has(roomCode);
    
    if (isFirstRoomCreator) {
      console.log(`Usuario ${displayName} está creando nueva sala ${roomCode}`);
    } else {
      socket.send(JSON.stringify({
        type: 'error',
        message: `La sala ${roomCode} ya no existe o ha sido cerrada.`
      }));
      console.log(`Intento fallido de unirse a sala inexistente ${roomCode} por usuario ${displayName}`);
      return;
    }
  }
  
  const reconnectionKey = `${displayName}_${roomCode}`;
  const lastDisconnection = recentDisconnections.get(reconnectionKey);
  const isReconnection = lastDisconnection && (Date.now() - lastDisconnection < RECONNECTION_WINDOW);
  
  if (isReconnection) {
    console.log(`Reconexión detectada para ${displayName}`);
    recentDisconnections.delete(reconnectionKey);
  }
  
  if (socketState.currentRoom && socketState.currentRoom !== roomCode) {
    handleLeaveRoom(socket, {
      type: 'leaveRoom',
      roomCode: socketState.currentRoom,
      userName: socketState.currentUser,
      displayName
    }, false, socketState);
  }
  
  socketState.currentRoom = roomCode;
  socketState.currentUser = userName;
  socket.displayName = displayName;
  
  if (!rooms.has(roomCode)) {
    createRoom(roomCode);
  }
  
  if (!roomMessages.has(roomCode)) {
    roomMessages.set(roomCode, []);
  }
  
  if (!roomParticipants.has(roomCode)) {
    roomParticipants.set(roomCode, new Map());
  }
  
  const { isFirstTimeJoining, hadLeftVoluntarily } = trackUserConnection(roomCode, displayName);
  
  if (!roomParticipants.get(roomCode).has(displayName)) {
    roomParticipants.get(roomCode).set(displayName, {
      name: displayName,
      status: "activo",
      connected: true,
      lastSeen: Date.now(),
      joinedAt: userJoinTimestamps.get(`${displayName}_${roomCode}`) || Date.now()
    });
  } else {
    const userInfo = roomParticipants.get(roomCode).get(displayName);
    userInfo.connected = true;
    userInfo.status = "activo";
    userInfo.lastSeen = Date.now();
  }
  
  const room = rooms.get(roomCode);
  let isNewUser = false;
  
  if (!room.users.has(displayName)) {
    room.users.set(displayName, {
      sockets: new Set(),
      status: "activo",
      typing: false,
      connected: true,
      lastActivity: Date.now()
    });
    room.userCount++;
    isNewUser = true;
  } else {
    const userInfo = room.users.get(displayName);
    userInfo.connected = true;
    userInfo.status = "activo";
    userInfo.lastActivity = Date.now();
  }
  
  room.users.get(displayName).sockets.add(socket);
  
  console.log(`Usuario ${displayName} agregado a sala ${roomCode} (total: ${room.userCount})`);
  
  if ((isNewUser && !isReconnection) || hadLeftVoluntarily) {
    const joinNotification = `${displayName} ha ingresado a la sala.`;
    const timestamp = addNotificationToHistory(roomCode, joinNotification);
    
    broadcastToRoom(roomCode, {
      type: 'message',
      roomCode: roomCode,
      message: joinNotification,
      timestamp: timestamp || Date.now()
    });
    
    console.log(`Notificación enviada: ${joinNotification}`);
  }
  
  updateUserList(roomCode);
  sendRecentMessageHistory(socket, roomCode, displayName);
}

function handleLeaveRoom(socket, message, isVoluntary, socketState) {
  if (!message.roomCode) return;
  
  const roomCode = message.roomCode;
  const displayName = getUserDisplayName(message);
  
  if (rooms.has(roomCode)) {
    const room = rooms.get(roomCode);
    
    if (room.users.has(displayName)) {
      const userInfo = room.users.get(displayName);
      userInfo.sockets.delete(socket);
      
      if (userInfo.sockets.size === 0) {
        if (isVoluntary) {
          removeUserFromRoom(roomCode, displayName, true);
          
          broadcastToRoom(roomCode, {
            type: 'message',
            roomCode,
            message: `${displayName} ha abandonado la sala.`,
            timestamp: Date.now()
          });
        } else {
          userInfo.connected = false;
          userInfo.lastActivity = Date.now();
          console.log(`Usuario ${displayName} desconectado temporalmente`);
          
          if (roomParticipants.has(roomCode) && roomParticipants.get(roomCode).has(displayName)) {
            const participant = roomParticipants.get(roomCode).get(displayName);
            participant.connected = false;
            participant.status = "desconectado";
            participant.lastSeen = Date.now();
          }
        }
        
        updateUserList(roomCode);
        cleanupEmptyRoom(roomCode);
      }
    }
  }
  
  if (socketState.currentRoom === roomCode) {
    socketState.currentRoom = null;
    socketState.currentUser = null;
  }
}

function handleSendMessage(socket, message, socketState) {
  if (!socketState.currentRoom || !socketState.currentUser) return;
  
  if (message.roomCode === socketState.currentRoom) {
    const senderDisplayName = getUserDisplayName(message);
    
    updateUserStatus(socketState.currentRoom, senderDisplayName, "activo");
    
    if (socketState.typingTimeout) {
      clearTimeout(socketState.typingTimeout);
      socketState.typingTimeout = null;
    }
    
    const room = rooms.get(socketState.currentRoom);
    if (room && room.users.has(senderDisplayName)) {
      room.users.get(senderDisplayName).typing = false;
      broadcastTypingStatus(socketState.currentRoom, senderDisplayName, false);
    }
    
    const { messageId, timestamp, formattedMessage } = createChatMessage(
      socketState.currentRoom, 
      senderDisplayName, 
      message.message
    );
    
    broadcastToRoom(socketState.currentRoom, {
      type: 'message',
      id: messageId,
      roomCode: socketState.currentRoom,
      sender: senderDisplayName,
      timestamp,
      status: MESSAGE_STATUS.DELIVERED,
      message: formattedMessage
    });
  }
}

function handleTypingStatus(socket, message, isTyping, socketState) {
  if (!socketState.currentRoom || !socketState.currentUser) return;
  
  const roomCode = message.roomCode;
  const displayName = getUserDisplayName(message);
  
  if (rooms.has(roomCode)) {
    const room = rooms.get(roomCode);
    if (room.users.has(displayName)) {
      const userInfo = room.users.get(displayName);
      userInfo.typing = isTyping;
      userInfo.lastActivity = Date.now();
      
      if (isTyping) {
        if (socketState.typingTimeout) {
          clearTimeout(socketState.typingTimeout);
        }
        
        socketState.typingTimeout = setTimeout(() => {
          if (rooms.has(roomCode) && room.users.has(displayName)) {
            room.users.get(displayName).typing = false;
            broadcastTypingStatus(roomCode, displayName, false);
          }
          socketState.typingTimeout = null;
        }, 3000);
      } else if (socketState.typingTimeout) {
        clearTimeout(socketState.typingTimeout);
        socketState.typingTimeout = null;
      }
      
      broadcastTypingStatus(roomCode, displayName, isTyping);
    }
  }
}

function handleUpdateStatus(socket, message, socketState) {
  if (!socketState.currentRoom || !socketState.currentUser) return;
  
  const roomCode = message.roomCode;
  const displayName = getUserDisplayName(message);
  const status = message.status || "activo";
  
  updateUserStatus(roomCode, displayName, status);
  updateUserList(roomCode);
}

function setupSocketHandlers(socket) {
  const socketState = {
    currentRoom: null,
    currentUser: null,
    typingTimeout: null
  };
  
  socket.on('message', (message) => {
    try {
      const parsedMessage = JSON.parse(message);
      console.log("Mensaje recibido:", parsedMessage.type);
      
      const handlers = {
        'joinRoom': () => handleJoinRoom(socket, parsedMessage, socketState),
        'sendMessage': () => handleSendMessage(socket, parsedMessage, socketState),
        'leaveRoom': () => handleLeaveRoom(socket, parsedMessage, true, socketState),
        'typing': () => handleTypingStatus(socket, parsedMessage, true, socketState),
        'stopTyping': () => handleTypingStatus(socket, parsedMessage, false, socketState),
        'updateStatus': () => handleUpdateStatus(socket, parsedMessage, socketState),
        'messageRead': () => {}
      };
      
      const handler = handlers[parsedMessage.type];
      if (handler) {
        handler();
      } else {
        console.log('Tipo de mensaje desconocido:', parsedMessage.type);
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
    }
  });
  
  socket.on('close', () => {
    console.log('Cliente desconectado');
    
    if (socketState.currentRoom && socketState.currentUser) {
      const displayName = socket.displayName || socketState.currentUser.split('_')[0];
      const reconnectionKey = `${displayName}_${socketState.currentRoom}`;
      
      recentDisconnections.set(reconnectionKey, Date.now());
      
      setTimeout(() => {
        if (recentDisconnections.has(reconnectionKey)) {
          recentDisconnections.delete(reconnectionKey);
        }
      }, RECONNECTION_WINDOW + 1000);
      
      handleLeaveRoom(socket, {
        type: 'leaveRoom',
        roomCode: socketState.currentRoom,
        userName: socketState.currentUser,
        displayName
      }, false, socketState);
    }
  });
  
  return socketState;
}

wss.on('connection', (socket) => {
  console.log('Cliente conectado');
  setupSocketHandlers(socket);
});

console.log('Servidor WebSocket listo y esperando conexiones...');
console.log('Presiona Ctrl+C para detener el servidor');