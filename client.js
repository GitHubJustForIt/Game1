// Verbindung herstellen
const socket = io("http://localhost:3000"); // oder Server-URL beim Deployment

const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const messages = document.getElementById("messages");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (input.value.trim() === "") return;
  socket.emit("chat message", input.value); // Nachricht an Server senden
  input.value = "";
});

socket.on("chat message", (msg) => {
  const li = document.createElement("li");
  li.textContent = msg;
  messages.appendChild(li);
  messages.scrollTop = messages.scrollHeight;
});
