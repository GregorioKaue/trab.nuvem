require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const pool = require("./db");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET não definido no .env");
  process.exit(1);
}

const app = express();
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:"]
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Utilidades ---------- */
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: "Não autenticado." });
  }
}

const exigirPerfil = (...perfis) => (req, res, next) =>
  perfis.includes(req.user.perfil)
    ? next()
    : res.status(403).json({ erro: "Sem permissão." });

function urlValida(u) {
  if (u == null || u === "") return true;
  try { return ["http:", "https:"].includes(new URL(u).protocol); }
  catch { return false; }
}

/* ---------- Autenticação ---------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erro: "Muitas tentativas. Tente novamente em alguns minutos." }
});

app.post("/api/auth/login", loginLimiter, wrap(async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: "Informe e-mail e senha." });
  }
  const [rows] = await pool.execute(
    "SELECT id, nome, email, senha_hash, perfil FROM usuarios WHERE email = ? AND ativo = 1",
    [String(email).toLowerCase()]
  );
  const u = rows[0];
  // compara sempre, para não revelar se o e-mail existe
  const ok = await bcrypt.compare(
    String(senha),
    u ? u.senha_hash : "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali"
  );
  if (!u || !ok) return res.status(401).json({ erro: "Credenciais inválidas." });

  const token = jwt.sign(
    { id: u.id, nome: u.nome, perfil: u.perfil },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || "8h" }
  );
  res.json({ token, usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil } });
}));

app.get("/api/auth/me", auth, (req, res) => res.json(req.user));

// Somente administradores cadastram usuários.
app.post("/api/usuarios", auth, exigirPerfil("admin"), wrap(async (req, res) => {
  const { nome, email, senha, perfil = "aluno" } = req.body || {};
  if (!nome || !email || !senha || senha.length < 8) {
    return res.status(400).json({ erro: "Nome, e-mail e senha (mín. 8 caracteres) são obrigatórios." });
  }
  if (!["aluno", "professor", "admin"].includes(perfil)) {
    return res.status(400).json({ erro: "Perfil inválido." });
  }
  try {
    const hash = await bcrypt.hash(senha, 12);
    const [r] = await pool.execute(
      "INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?,?,?,?)",
      [nome.trim(), email.toLowerCase().trim(), hash, perfil]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ erro: "E-mail já cadastrado." });
    throw e;
  }
}));

/* ---------- Recursos (cards da página) ---------- */
// Público: lista e pesquisa por nome/descrição.
app.get("/api/recursos", wrap(async (req, res) => {
  const { categoria, q } = req.query;
  const where = ["ativo = 1"];
  const params = [];
  if (["ferramenta", "academico"].includes(categoria)) {
    where.push("categoria = ?"); params.push(categoria);
  }
  if (q && String(q).trim()) {
    where.push("(nome LIKE ? OR descricao LIKE ?)");
    const termo = `%${String(q).trim().replace(/[%_]/g, "\\$&")}%`;
    params.push(termo, termo);
  }
  const [rows] = await pool.execute(
    `SELECT id, categoria, nome, descricao, icone, url
       FROM recursos WHERE ${where.join(" AND ")} ORDER BY ordem, nome`,
    params
  );
  res.json(rows);
}));

app.post("/api/recursos", auth, exigirPerfil("admin"), wrap(async (req, res) => {
  const { categoria, nome, descricao, icone = "🔗", url = null, ordem = 0 } = req.body || {};
  if (!["ferramenta", "academico"].includes(categoria) || !nome || !descricao) {
    return res.status(400).json({ erro: "categoria, nome e descricao são obrigatórios." });
  }
  if (!urlValida(url)) return res.status(400).json({ erro: "URL inválida (use http/https)." });
  const [r] = await pool.execute(
    "INSERT INTO recursos (categoria, nome, descricao, icone, url, ordem) VALUES (?,?,?,?,?,?)",
    [categoria, nome, descricao, icone, url || null, Number(ordem) || 0]
  );
  res.status(201).json({ id: r.insertId });
}));

app.put("/api/recursos/:id", auth, exigirPerfil("admin"), wrap(async (req, res) => {
  const { nome, descricao, icone, url, ordem, ativo } = req.body || {};
  if (!urlValida(url)) return res.status(400).json({ erro: "URL inválida (use http/https)." });
  const [r] = await pool.execute(
    `UPDATE recursos SET
       nome = COALESCE(?, nome), descricao = COALESCE(?, descricao),
       icone = COALESCE(?, icone), url = COALESCE(?, url),
       ordem = COALESCE(?, ordem), ativo = COALESCE(?, ativo)
     WHERE id = ?`,
    [nome ?? null, descricao ?? null, icone ?? null, url ?? null,
     ordem ?? null, ativo == null ? null : (ativo ? 1 : 0), req.params.id]
  );
  if (!r.affectedRows) return res.status(404).json({ erro: "Recurso não encontrado." });
  res.json({ ok: true });
}));

app.delete("/api/recursos/:id", auth, exigirPerfil("admin"), wrap(async (req, res) => {
  const [r] = await pool.execute("DELETE FROM recursos WHERE id = ?", [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ erro: "Recurso não encontrado." });
  res.json({ ok: true });
}));

/* ---------- Documentos escolares ---------- */
const EXT_PERMITIDAS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".png", ".jpg", ".jpeg"
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) =>
    cb(null, EXT_PERMITIDAS.has(path.extname(file.originalname).toLowerCase()))
});

app.get("/api/documentos", auth, wrap(async (req, res) => {
  const admin = req.user.perfil === "admin";
  const [rows] = await pool.execute(
    `SELECT id, nome_original AS nome, mime, tamanho, criado_em
       FROM documentos ${admin ? "" : "WHERE usuario_id = ?"}
       ORDER BY criado_em DESC`,
    admin ? [] : [req.user.id]
  );
  res.json(rows);
}));

app.post("/api/documentos", auth, upload.array("arquivos", 10), wrap(async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ erro: "Nenhum arquivo válido enviado." });
  }
  for (const f of req.files) {
    // multer interpreta o nome como latin1; converte para UTF-8
    const nome = Buffer.from(f.originalname, "latin1").toString("utf8");
    await pool.execute(
      `INSERT INTO documentos (usuario_id, nome_original, nome_arquivo, mime, tamanho)
       VALUES (?,?,?,?,?)`,
      [req.user.id, nome.slice(0, 255), f.filename, f.mimetype, f.size]
    );
  }
  res.status(201).json({ enviados: req.files.length });
}));

async function buscarDocumento(req) {
  const [rows] = await pool.execute("SELECT * FROM documentos WHERE id = ?", [req.params.id]);
  const d = rows[0];
  if (!d) return null;
  if (req.user.perfil !== "admin" && d.usuario_id !== req.user.id) return null;
  return d;
}

app.get("/api/documentos/:id/download", auth, wrap(async (req, res) => {
  const d = await buscarDocumento(req);
  if (!d) return res.status(404).json({ erro: "Documento não encontrado." });
  res.download(path.join(UPLOAD_DIR, d.nome_arquivo), d.nome_original);
}));

app.delete("/api/documentos/:id", auth, wrap(async (req, res) => {
  const d = await buscarDocumento(req);
  if (!d) return res.status(404).json({ erro: "Documento não encontrado." });
  await pool.execute("DELETE FROM documentos WHERE id = ?", [d.id]);
  fs.promises.unlink(path.join(UPLOAD_DIR, d.nome_arquivo)).catch(() => {});
  res.json({ ok: true });
}));

/* ---------- Erros ---------- */
app.use("/api", (req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ erro: "Falha no upload: " + err.message });
  }
  console.error(err);
  res.status(500).json({ erro: "Erro interno do servidor." });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`EduConnect em http://localhost:${PORT}`));
