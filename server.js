const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // wichtig, falls du von verschiedenen Hosts zugreifst
  },
});

app.use(express.static(__dirname)); // index.html, style.css, client.js liegen hier

io.on("connection", (socket) => {
  console.log("👤 Nutzer verbunden:", socket.id);

  // Empfangen von Nachrichten vom Client
  socket.on("chat message", (msg) => {
    console.log("📤 Nachricht:", msg);
    io.emit("chat message", msg); // Senden an alle Clients
  });

  socket.on("disconnect", () => {
    console.log("🔴 Nutzer getrennt:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("🚀 Server läuft auf http://localhost:3000");
});
