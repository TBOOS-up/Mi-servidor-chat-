// ============================================================
//  Servidor del chat de Sebastian (estilo WhatsApp) - v1
//  - API REST para registro, chats, mensajes y estados
//  - WebSocket en /ws para mensajes en tiempo real y llamadas
//  - Base de datos SQLite en archivo (chat.db), sin nada externo
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

// ---- Configuración ----
const PUERTO = process.env.PORT || 3000;

// ---- Base de datos (archivo local chat.db) ----
const db = new Database('chat.db');

// Creamos las tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    creado TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creado TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_participantes (
    chat_id INTEGER NOT NULL,
    usuario_id INTEGER NOT NULL,
    UNIQUE(chat_id, usuario_id)
  );
  CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    remitente_id INTEGER NOT NULL,
    texto TEXT NOT NULL,
    creado TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS estados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    texto TEXT NOT NULL,
    creado TEXT NOT NULL
  );
`);

// ---- App Express ----
const app = express();

// Permitimos llamadas desde la app del teléfono (otro origen)
app.use(cors());
app.use(express.json());

// ---- Utilidades ----
function ahora() {
  return new Date().toISOString();
}

// Busca el usuario por su token (para el WebSocket también)
function usuarioPorToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM usuarios WHERE token = ?').get(token);
}

// ---- Middleware de autenticación ----
// El teléfono manda: Authorization: Bearer <token>
function auth(req, res, next) {
  const encabezado = req.headers.authorization || '';
  const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : null;
  const usuario = usuarioPorToken(token);
  if (!usuario) {
    return res.status(401).json({ error: 'No autorizado: token inválido o faltante' });
  }
  req.usuario = usuario;
  next();
}

// ---- Revisión de salud (para saber si el servidor vive) ----
app.get('/api/salud', (req, res) => {
  res.json({ ok: true });
});

// ---- Registro ----
// v1: SIN verificación por SMS de verdad. Eso llega después con un
// proveedor de SMS de pago. Por ahora el número se guarda tal cual.
app.post('/api/register', (req, res) => {
  const { telefono, nombre } = req.body || {};
  if (!telefono || !nombre) {
    return res.status(400).json({ error: 'Faltan telefono y nombre' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    const r = db
      .prepare('INSERT INTO usuarios (telefono, nombre, token, creado) VALUES (?, ?, ?, ?)')
      .run(String(telefono).trim(), String(nombre).trim(), token, ahora());
    return res.json({ userId: r.lastInsertRowid, token });
  } catch (e) {
    // Si el teléfono ya existe, devolvemos su token (volver a entrar)
    const existente = db.prepare('SELECT id, token FROM usuarios WHERE telefono = ?').get(String(telefono).trim());
    if (existente) {
      return res.json({ userId: existente.id, token: existente.token });
    }
    return res.status(500).json({ error: 'No se pudo registrar' });
  }
});

// ---- Chats: lista de mis conversaciones con el último mensaje ----
app.get('/api/chats', auth, (req, res) => {
  const filas = db.prepare(`
    SELECT c.id AS chatId,
           u.id AS otroId, u.nombre AS otroNombre, u.telefono AS otroTelefono,
           (SELECT texto FROM mensajes m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS ultimoTexto,
           (SELECT creado FROM mensajes m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS ultimoCreado
    FROM chats c
    JOIN chat_participantes p1 ON p1.chat_id = c.id AND p1.usuario_id = ?
    JOIN chat_participantes p2 ON p2.chat_id = c.id AND p2.usuario_id != ?
    JOIN usuarios u ON u.id = p2.usuario_id
    ORDER BY ultimoCreado DESC
  `).all(req.usuario.id, req.usuario.id);
  res.json(filas);
});

// ---- Chats: crear (o recuperar) un chat 1 a 1 con otro teléfono ----
app.post('/api/chats', auth, (req, res) => {
  const { telefonoDestino } = req.body || {};
  if (!telefonoDestino) {
    return res.status(400).json({ error: 'Falta telefonoDestino' });
  }
  const destino = db.prepare('SELECT id FROM usuarios WHERE telefono = ?').get(String(telefonoDestino).trim());
  if (!destino) {
    return res.status(404).json({ error: 'Ese teléfono no está registrado en el chat' });
  }
  if (destino.id === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes chatear contigo mismo' });
  }
  // Buscamos si ya existe un chat entre los dos
  const existente = db.prepare(`
    SELECT p1.chat_id AS chatId
    FROM chat_participantes p1
    JOIN chat_participantes p2 ON p2.chat_id = p1.chat_id
    WHERE p1.usuario_id = ? AND p2.usuario_id = ?
    LIMIT 1
  `).get(req.usuario.id, destino.id);
  if (existente) {
    return res.json({ chatId: existente.chatId });
  }
  // Si no existe, lo creamos
  const crear = db.transaction(() => {
    const c = db.prepare('INSERT INTO chats (creado) VALUES (?)').run(ahora());
    const chatId = c.lastInsertRowid;
    db.prepare('INSERT INTO chat_participantes (chat_id, usuario_id) VALUES (?, ?)').run(chatId, req.usuario.id);
    db.prepare('INSERT INTO chat_participantes (chat_id, usuario_id) VALUES (?, ?)').run(chatId, destino.id);
    return chatId;
  });
  res.json({ chatId: crear() });
});

// ---- Mensajes: historial de un chat ----
app.get('/api/chats/:id/mensajes', auth, (req, res) => {
  const chatId = Number(req.params.id);
  const soyParte = db.prepare(
    'SELECT 1 FROM chat_participantes WHERE chat_id = ? AND usuario_id = ?'
  ).get(chatId, req.usuario.id);
  if (!soyParte) {
    return res.status(403).json({ error: 'No perteneces a este chat' });
  }
  const mensajes = db.prepare(`
    SELECT m.id, m.texto, m.creado, m.remitente_id AS remitenteId, u.nombre AS remitenteNombre
    FROM mensajes m
    JOIN usuarios u ON u.id = m.remitente_id
    WHERE m.chat_id = ?
    ORDER BY m.id ASC
  `).all(chatId);
  res.json(mensajes);
});

// ---- Mensajes: enviar (guarda y avisa en tiempo real al otro) ----
app.post('/api/mensajes', auth, (req, res) => {
  const { chatId, texto } = req.body || {};
  if (!chatId || !texto) {
    return res.status(400).json({ error: 'Faltan chatId y texto' });
  }
  const soyParte = db.prepare(
    'SELECT 1 FROM chat_participantes WHERE chat_id = ? AND usuario_id = ?'
  ).get(Number(chatId), req.usuario.id);
  if (!soyParte) {
    return res.status(403).json({ error: 'No perteneces a este chat' });
  }
  const r = db.prepare(
    'INSERT INTO mensajes (chat_id, remitente_id, texto, creado) VALUES (?, ?, ?, ?)'
  ).run(Number(chatId), req.usuario.id, String(texto), ahora());

  const mensaje = {
    id: r.lastInsertRowid,
    chatId: Number(chatId),
    texto: String(texto),
    creado: ahora(),
    remitenteId: req.usuario.id,
    remitenteNombre: req.usuario.nombre,
  };

  // Avisamos en tiempo real al otro participante (si está conectado)
  const otro = db.prepare(
    'SELECT usuario_id FROM chat_participantes WHERE chat_id = ? AND usuario_id != ?'
  ).get(Number(chatId), req.usuario.id);
  if (otro) {
    enviarAUsuario(otro.usuario_id, { tipo: 'mensaje-nuevo', mensaje });
  }

  res.json(mensaje);
});

// ---- Estados: publicar el mío ----
app.post('/api/estados', auth, (req, res) => {
  const { texto } = req.body || {};
  if (!texto) {
    return res.status(400).json({ error: 'Falta el texto del estado' });
  }
  const r = db.prepare(
    'INSERT INTO estados (usuario_id, texto, creado) VALUES (?, ?, ?)'
  ).run(req.usuario.id, String(texto), ahora());
  res.json({ id: r.lastInsertRowid });
});

// ---- Estados: ver los de las últimas 24 horas ----
app.get('/api/estados', auth, (req, res) => {
  const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const estados = db.prepare(`
    SELECT e.id, e.texto, e.creado, u.nombre AS autorNombre, u.telefono AS autorTelefono
    FROM estados e
    JOIN usuarios u ON u.id = e.usuario_id
    WHERE e.creado >= ?
    ORDER BY e.creado DESC
  `).all(hace24h);
  res.json(estados);
});

// ---- Servidor HTTP ----
const servidor = app.listen(PUERTO, () => {
  console.log('Servidor del chat escuchando en el puerto ' + PUERTO);
});

// ============================================================
//  WebSocket en /ws?token=...
//  - Guarda qué socket pertenece a cada usuario
//  - {tipo:"mensaje", chatId, texto}  -> envía y reenvía al otro
//  - {tipo:"llamada-oferta"|"llamada-respuesta"|"llamada-ice", para, datos}
//    -> se reenvían tal cual al destinatario (para llamadas futuras)
// ============================================================
const wss = new WebSocketServer({ server: servidor, path: '/ws' });

// usuarioId -> conjunto de sockets conectados
const conectados = new Map();

function enviarAUsuario(usuarioId, objeto) {
  const sockets = conectados.get(usuarioId);
  if (!sockets) return;
  const texto = JSON.stringify(objeto);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(texto);
  }
}

wss.on('connection', (ws, req) => {
  // El token viene en la URL: /ws?token=...
  const url = new URL(req.url, 'http://localhost');
  const usuario = usuarioPorToken(url.searchParams.get('token'));
  if (!usuario) {
    ws.close(4401, 'Token inválido');
    return;
  }

  // Registramos este socket para el usuario
  if (!conectados.has(usuario.id)) conectados.set(usuario.id, new Set());
  conectados.get(usuario.id).add(ws);

  ws.on('message', (datos) => {
    let msg;
    try {
      msg = JSON.parse(datos.toString());
    } catch {
      return; // ignoramos lo que no sea JSON
    }

    // Enviar mensaje de chat por el socket
    if (msg.tipo === 'mensaje' && msg.chatId && msg.texto) {
      const soyParte = db.prepare(
        'SELECT 1 FROM chat_participantes WHERE chat_id = ? AND usuario_id = ?'
      ).get(Number(msg.chatId), usuario.id);
      if (!soyParte) return;
      const r = db.prepare(
        'INSERT INTO mensajes (chat_id, remitente_id, texto, creado) VALUES (?, ?, ?, ?)'
      ).run(Number(msg.chatId), usuario.id, String(msg.texto), ahora());
      const mensaje = {
        id: r.lastInsertRowid,
        chatId: Number(msg.chatId),
        texto: String(msg.texto),
        creado: ahora(),
        remitenteId: usuario.id,
        remitenteNombre: usuario.nombre,
      };
      const otro = db.prepare(
        'SELECT usuario_id FROM chat_participantes WHERE chat_id = ? AND usuario_id != ?'
      ).get(Number(msg.chatId), usuario.id);
      if (otro) {
        enviarAUsuario(otro.usuario_id, { tipo: 'mensaje-nuevo', mensaje });
      }
      // Confirmamos al que envió
      ws.send(JSON.stringify({ tipo: 'mensaje-enviado', mensaje }));
      return;
    }

    // Señalización de llamadas: se reenvía tal cual al destinatario
    if (
      (msg.tipo === 'llamada-oferta' || msg.tipo === 'llamada-respuesta' || msg.tipo === 'llamada-ice') &&
      msg.para
    ) {
      const destino = db.prepare('SELECT id FROM usuarios WHERE telefono = ?').get(String(msg.para).trim());
      if (destino) {
        enviarAUsuario(destino.id, {
          tipo: msg.tipo,
          de: usuario.telefono,
          deNombre: usuario.nombre,
          datos: msg.datos || null,
        });
      }
      return;
    }
  });

  ws.on('close', () => {
    const sockets = conectados.get(usuario.id);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) conectados.delete(usuario.id);
    }
  });
});
