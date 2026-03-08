const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname)); // alles im gleichen Ordner

io.on("connection", (socket) => {
  console.log("👤 Nutzer verbunden");

  socket.on("chat message", (msg) => {
    io.emit("chat message", msg); // Global an alle
  });

  socket.on("disconnect", () => {
    console.log("🔴 Nutzer getrennt");
  });
});

server.listen(3000, () => {
  console.log("🚀 Server läuft auf http://localhost:3000");
});
