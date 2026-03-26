// Socket management singleton
let ioInstance = null;
const connectedUsers = {};

function setIo(io) {
    ioInstance = io;
}

function getIo() {
    return ioInstance;
}

function getConnectedUsers() {
    return connectedUsers;
}

export { setIo, getIo, getConnectedUsers, connectedUsers }