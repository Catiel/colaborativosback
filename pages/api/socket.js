import { Server } from 'socket.io';

// Constantes para la gestión del chat
const RECONNECTION_WINDOW = 10000;
const MESSAGE_STATUS = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  ERROR: 'error'
};

// Almacenamiento en memoria (podría reemplazarse por una base de datos)
const rooms = new Map();
const recentDisconnections = new Map();
const roomMessages = new Map();
const roomParticipants = new Map();
const userJoinTimestamps = new Map();

// Función para obtener una sala si existe
function getRoomIfExists(roomCode) {
  return rooms.get(roomCode);
}

// Función para crear una nueva sala
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

// Función para eliminar un usuario de una sala
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

// Función para limpiar salas vacías
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

// Obtener nombre de usuario para mostrar
function getUserDisplayName(messageData) {
  return messageData.displayName || messageData.userName.split('_')[0];
}

// Rastreo de conexiones de usuario
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

// Actualización de estado de usuario
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

// Añadir notificaciones al historial
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

// Crear un mensaje de chat
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

// Enviar historial de mensajes recientes
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
    socket.emit('messageHistory', {
      type: 'messageHistory',
      roomCode,
      messages: relevantMessages
    });
  } else {
    console.log(`No hay mensajes relevantes para enviar a ${displayName} (se unió en ${new Date(userJoinTime).toLocaleString()})`);
  }
}

// Actualizar lista de usuarios
function updateUserList(io, roomCode) {
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
  
  io.to(roomCode).emit('userList', {
    type: 'userList',
    roomCode,
    count: room.userCount,
    activeCount: connectedCount,
    users: userList
  });
}

const SocketHandler = (req, res) => {
  // Verificar si ya hemos inicializado Socket.io
  if (res.socket.server.io) {
    console.log('Socket.io ya está inicializado');
    res.end();
    return;
  }
  
  console.log('Configurando Socket.io');
  const io = new Server(res.socket.server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  
  res.socket.server.io = io;

  // Configuración de Socket.IO con manejadores de eventos
  io.on('connection', (socket) => {
    console.log('Cliente conectado');
    
    const socketState = {
      currentRoom: null,
      currentUser: null,
      typingTimeout: null
    };

    // Evento para unirse a una sala
    socket.on('joinRoom', (message) => {
      const roomCode = message.roomCode;
      const userName = message.userName;
      const displayName = getUserDisplayName(message);
      
      const salaExistente = rooms.has(roomCode);
      
      if (!salaExistente) {
        const isFirstRoomCreator = !roomParticipants.has(roomCode);
        
        if (isFirstRoomCreator) {
          console.log(`Usuario ${displayName} está creando nueva sala ${roomCode}`);
        } else {
          socket.emit('error', {
            type: 'error',
            message: `La sala ${roomCode} ya no existe o ha sido cerrada.`
          });
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
        // Dejar sala anterior si existe
        socket.leave(socketState.currentRoom);
        
        if (rooms.has(socketState.currentRoom)) {
          const room = rooms.get(socketState.currentRoom);
          
          if (room.users.has(displayName)) {
            const userInfo = room.users.get(displayName);
            userInfo.connected = false;
            userInfo.lastActivity = Date.now();
            
            if (roomParticipants.has(socketState.currentRoom) && roomParticipants.get(socketState.currentRoom).has(displayName)) {
              const participant = roomParticipants.get(socketState.currentRoom).get(displayName);
              participant.connected = false;
              participant.status = "desconectado";
              participant.lastSeen = Date.now();
            }
            
            updateUserList(io, socketState.currentRoom);
          }
        }
      }
      
      // Unirse a la nueva sala en Socket.IO
      socket.join(roomCode);
      
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
          joinedAt: userJoinTimestamps.get(`${displayName}_${roomCode}`) || Date.now(),
          socketId: socket.id
        });
      } else {
        const userInfo = roomParticipants.get(roomCode).get(displayName);
        userInfo.connected = true;
        userInfo.status = "activo";
        userInfo.lastSeen = Date.now();
        userInfo.socketId = socket.id;
      }
      
      const room = rooms.get(roomCode);
      let isNewUser = false;
      
      if (!room.users.has(displayName)) {
        room.users.set(displayName, {
          socketId: socket.id,
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
        userInfo.socketId = socket.id;
      }
      
      console.log(`Usuario ${displayName} agregado a sala ${roomCode} (total: ${room.userCount})`);
      
      if ((isNewUser && !isReconnection) || hadLeftVoluntarily) {
        const joinNotification = `${displayName} ha ingresado a la sala.`;
        const timestamp = addNotificationToHistory(roomCode, joinNotification);
        
        io.to(roomCode).emit('message', {
          type: 'message',
          roomCode: roomCode,
          message: joinNotification,
          timestamp: timestamp || Date.now()
        });
        
        console.log(`Notificación enviada: ${joinNotification}`);
      }
      
      updateUserList(io, roomCode);
      sendRecentMessageHistory(socket, roomCode, displayName);
    });

    // Evento para enviar mensajes
    socket.on('sendMessage', (message) => {
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
          io.to(socketState.currentRoom).emit('typingStatus', {
            roomCode: socketState.currentRoom,
            userName: senderDisplayName,
            isTyping: false
          });
        }
        
        const { messageId, timestamp, formattedMessage } = createChatMessage(
          socketState.currentRoom, 
          senderDisplayName, 
          message.message
        );
        
        io.to(socketState.currentRoom).emit('message', {
          type: 'message',
          id: messageId,
          roomCode: socketState.currentRoom,
          sender: senderDisplayName,
          timestamp,
          status: MESSAGE_STATUS.DELIVERED,
          message: formattedMessage
        });
      }
    });

    // Evento para salir de una sala
    socket.on('leaveRoom', (message) => {
      if (!message.roomCode) return;
      
      const roomCode = message.roomCode;
      const displayName = getUserDisplayName(message);
      
      // Dejar la sala en Socket.IO
      socket.leave(roomCode);
      
      if (rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        
        if (room.users.has(displayName)) {
          removeUserFromRoom(roomCode, displayName, true);
          
          io.to(roomCode).emit('message', {
            type: 'message',
            roomCode,
            message: `${displayName} ha abandonado la sala.`,
            timestamp: Date.now()
          });
          
          updateUserList(io, roomCode);
          cleanupEmptyRoom(roomCode);
        }
      }
      
      if (socketState.currentRoom === roomCode) {
        socketState.currentRoom = null;
        socketState.currentUser = null;
      }
    });

    // Eventos de escritura
    socket.on('typing', (message) => {
      if (!socketState.currentRoom || !socketState.currentUser) return;
      
      const roomCode = message.roomCode;
      const displayName = getUserDisplayName(message);
      
      if (rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        if (room.users.has(displayName)) {
          const userInfo = room.users.get(displayName);
          userInfo.typing = true;
          userInfo.lastActivity = Date.now();
          
          if (socketState.typingTimeout) {
            clearTimeout(socketState.typingTimeout);
          }
          
          socketState.typingTimeout = setTimeout(() => {
            if (rooms.has(roomCode) && room.users.has(displayName)) {
              room.users.get(displayName).typing = false;
              io.to(roomCode).emit('typingStatus', {
                roomCode,
                userName: displayName,
                isTyping: false
              });
            }
            socketState.typingTimeout = null;
          }, 3000);
          
          io.to(roomCode).emit('typingStatus', {
            roomCode,
            userName: displayName,
            isTyping: true
          });
        }
      }
    });

    socket.on('stopTyping', (message) => {
      if (!socketState.currentRoom || !socketState.currentUser) return;
      
      const roomCode = message.roomCode;
      const displayName = getUserDisplayName(message);
      
      if (rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        if (room.users.has(displayName)) {
          const userInfo = room.users.get(displayName);
          userInfo.typing = false;
          userInfo.lastActivity = Date.now();
          
          if (socketState.typingTimeout) {
            clearTimeout(socketState.typingTimeout);
            socketState.typingTimeout = null;
          }
          
          io.to(roomCode).emit('typingStatus', {
            roomCode,
            userName: displayName,
            isTyping: false
          });
        }
      }
    });

    // Actualización de estado
    socket.on('updateStatus', (message) => {
      if (!socketState.currentRoom || !socketState.currentUser) return;
      
      const roomCode = message.roomCode;
      const displayName = getUserDisplayName(message);
      const status = message.status || "activo";
      
      updateUserStatus(roomCode, displayName, status);
      updateUserList(io, roomCode);
    });

    // Evento de desconexión
    socket.on('disconnect', () => {
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
        
        if (rooms.has(socketState.currentRoom)) {
          const room = rooms.get(socketState.currentRoom);
          
          if (room.users.has(displayName)) {
            const userInfo = room.users.get(displayName);
            userInfo.connected = false;
            userInfo.lastActivity = Date.now();
            
            if (roomParticipants.has(socketState.currentRoom) && roomParticipants.get(socketState.currentRoom).has(displayName)) {
              const participant = roomParticipants.get(socketState.currentRoom).get(displayName);
              participant.connected = false;
              participant.status = "desconectado";
              participant.lastSeen = Date.now();
            }
            
            updateUserList(io, socketState.currentRoom);
            cleanupEmptyRoom(socketState.currentRoom);
          }
        }
      }
    });
  });

  console.log('Socket.io inicializado');
  res.end();
};

export default SocketHandler; 