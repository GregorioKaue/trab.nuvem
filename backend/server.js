'use strict';

/**
 * EduConnect — API REST (Node.js + Express + MySQL no alwaysdata)
 *
 * Cobre as telas: login, esqueci-senha, perfil/desempenho (aluno),
 * painel-professor (CRUD de alunos, notas, faltas, documentos, anos)
 * e secretaria (solicitações de documentos).
 */

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const {
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
  JWT_SECRET, JWT_EXPIRES = '8h',
  CORS_ORIGIN = '', FRONTEND_DIR = '', SEED_DEMO = 'false'
} = process.env;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Defina JWT_SECRET (mínimo de 32 caracteres) no arquivo .env.');
  process.exit(1);
}
if (!DB_HOST || !DB_USER || !DB_NAME) {
  console.error('Defina DB_HOST, DB_USER, DB_PASSWORD e DB_NAME no arquivo .env.');
  process.exit(1);
}

// Constantes iguais às do frontend.
const DISC = ['Português', 'Matemática', 'História', 'Ciências'];
const AULAS_MES = { 'Português': 16, 'Matemática': 16, 'História': 8, 'Ciências': 8 };
const N_MESES = 10;   // Fev–Jun e Ago–Dez (julho é recesso)
const N_BIM = 3;
const DOC_PADRAO = [
  'Certidão de nascimento', 'RG do aluno', 'CPF do aluno', 'Comprovante de residência',
  'Histórico escolar', 'Cartão de vacinação', 'Foto 3x4', 'Termo de autorização de imagem'
];
const SITUACOES = ['entregue', 'analise', 'pendente'];
const DOCS_SECRETARIA = ['Declaração de matrícula', 'Histórico escolar', 'Atestado de frequência', 'Outro assunto'];
const STATUS_SOLICITACAO = ['recebida', 'em_andamento', 'concluida', 'cancelada'];

// Conexão com o MySQL do alwaysdata. O plano gratuito limita conexões simultâneas,
// por isso o pool é pequeno.
const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT) || 3306,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4',
  dateStrings: true // DATE volta como 'AAAA-MM-DD' (sem problema de fuso)
});

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const texto = (v, max, campo, obrigatorio = true) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && obrigatorio) throw new HttpError(400, `Campo obrigatório: ${campo}.`);
  if (s.length > max) throw new HttpError(400, `${campo} excede ${max} caracteres.`);
  return s;
};
const emailValido = e => /^\S+@\S+\.\S+$/.test(e) && e.length <= 150;
const idParam = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Identificador inválido.');
  return n;
};
const anoParam = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) throw new HttpError(400, 'Ano letivo inválido.');
  return n;
};
// Nota: null ou número de 0 a 10 (1 casa decimal).
const nota = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new HttpError(400, 'Nota inválida (use 0 a 10).');
  return Math.round(n * 10) / 10;
};
// Faltas: null ou inteiro entre 0 e o total de aulas do mês na disciplina.
const falta = (v, disc) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > AULAS_MES[disc]) {
    throw new HttpError(400, `Faltas inválidas em ${disc} (inteiro de 0 a ${AULAS_MES[disc]}).`);
  }
  return n;
};
const dataISO = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) {
    throw new HttpError(400, 'Data inválida (use AAAA-MM-DD).');
  }
  return v;
};
function cpfValido(valor) {
  const n = String(valor || '').replace(/\D/g, '');
  if (n.length !== 11 || /^(\d)\1{10}$/.test(n)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(n[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(n[t])) return false;
  }
  return true;
}
const estruturaAnoVazia = () => {
  const o = { bim: {}, notas: {}, faltas: {} };
  DISC.forEach(d => {
    o.bim[d] = Array(N_BIM).fill(null);
    o.notas[d] = Array(N_MESES).fill(null);
    o.faltas[d] = Array(N_MESES).fill(null);
  });
  return o;
};

// ---------------------------------------------------------------------------
// Banco: criação das tabelas (executa só se ainda não existirem)
// ---------------------------------------------------------------------------
const TABELAS = [
  `CREATE TABLE IF NOT EXISTS alunos (
     id INT AUTO_INCREMENT PRIMARY KEY,
     nome VARCHAR(120) NOT NULL,
     email VARCHAR(150) NOT NULL UNIQUE,
     turma VARCHAR(40) NOT NULL,
     matricula VARCHAR(30) NOT NULL UNIQUE,
     criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS usuarios (
     id INT AUTO_INCREMENT PRIMARY KEY,
     nome VARCHAR(120) NOT NULL,
     email VARCHAR(150) NOT NULL UNIQUE,
     senha_hash VARCHAR(100) NOT NULL,
     perfil ENUM('aluno','professor') NOT NULL,
     aluno_id INT NULL,
     criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT fk_usuario_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS anos_letivos (
     ano SMALLINT PRIMARY KEY
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notas_bimestrais (
     aluno_id INT NOT NULL, ano SMALLINT NOT NULL,
     disciplina VARCHAR(40) NOT NULL, bimestre TINYINT NOT NULL,
     nota DECIMAL(3,1) NOT NULL,
     PRIMARY KEY (aluno_id, ano, disciplina, bimestre),
     CONSTRAINT fk_bim_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notas_mensais (
     aluno_id INT NOT NULL, ano SMALLINT NOT NULL,
     disciplina VARCHAR(40) NOT NULL, mes_idx TINYINT NOT NULL,
     nota DECIMAL(3,1) NOT NULL,
     PRIMARY KEY (aluno_id, ano, disciplina, mes_idx),
     CONSTRAINT fk_nm_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS faltas_mensais (
     aluno_id INT NOT NULL, ano SMALLINT NOT NULL,
     disciplina VARCHAR(40) NOT NULL, mes_idx TINYINT NOT NULL,
     faltas TINYINT NOT NULL,
     PRIMARY KEY (aluno_id, ano, disciplina, mes_idx),
     CONSTRAINT fk_fm_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS documentos_aluno (
     aluno_id INT NOT NULL, nome VARCHAR(80) NOT NULL,
     situacao ENUM('entregue','analise','pendente') NOT NULL DEFAULT 'pendente',
     data_entrega DATE NULL,
     PRIMARY KEY (aluno_id, nome),
     CONSTRAINT fk_doc_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS solicitacoes (
     id INT AUTO_INCREMENT PRIMARY KEY,
     protocolo VARCHAR(30) NOT NULL UNIQUE,
     nome VARCHAR(120) NOT NULL,
     email VARCHAR(150) NOT NULL,
     matricula VARCHAR(30) NULL,
     documento VARCHAR(60) NOT NULL,
     detalhes TEXT NULL,
     status ENUM('recebida','em_andamento','concluida','cancelada') NOT NULL DEFAULT 'recebida',
     criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS recuperacoes_senha (
     id INT AUTO_INCREMENT PRIMARY KEY,
     email VARCHAR(150) NOT NULL,
     criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function criarTabelas() {
  for (const sql of TABELAS) await pool.query(sql);
}

// ---------------------------------------------------------------------------
// Operações reutilizadas (aceitam uma conexão para uso em transações)
// ---------------------------------------------------------------------------
async function criarDocumentosPendentes(conn, alunoId) {
  const linhas = DOC_PADRAO.map(n => [alunoId, n, 'pendente', null]);
  await conn.query('INSERT IGNORE INTO documentos_aluno (aluno_id, nome, situacao, data_entrega) VALUES ?', [linhas]);
}

async function lerAno(alunoId, ano) {
  const out = estruturaAnoVazia();
  const [bim] = await pool.execute('SELECT disciplina, bimestre, nota FROM notas_bimestrais WHERE aluno_id=? AND ano=?', [alunoId, ano]);
  const [nm] = await pool.execute('SELECT disciplina, mes_idx, nota FROM notas_mensais WHERE aluno_id=? AND ano=?', [alunoId, ano]);
  const [fm] = await pool.execute('SELECT disciplina, mes_idx, faltas FROM faltas_mensais WHERE aluno_id=? AND ano=?', [alunoId, ano]);
  bim.forEach(r => { if (out.bim[r.disciplina]) out.bim[r.disciplina][r.bimestre] = Number(r.nota); });
  nm.forEach(r => { if (out.notas[r.disciplina]) out.notas[r.disciplina][r.mes_idx] = Number(r.nota); });
  fm.forEach(r => { if (out.faltas[r.disciplina]) out.faltas[r.disciplina][r.mes_idx] = Number(r.faltas); });
  return out;
}

// Valida o corpo e devolve as linhas prontas para gravar.
function validarAno(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Corpo da requisição inválido.');
  const linhas = { bim: [], notas: [], faltas: [] };
  for (const d of DISC) {
    const b = body.bim?.[d] ?? Array(N_BIM).fill(null);
    const n = body.notas?.[d] ?? Array(N_MESES).fill(null);
    const f = body.faltas?.[d] ?? Array(N_MESES).fill(null);
    if (!Array.isArray(b) || b.length !== N_BIM) throw new HttpError(400, `Notas bimestrais de ${d}: esperado ${N_BIM} valores.`);
    if (!Array.isArray(n) || n.length !== N_MESES) throw new HttpError(400, `Notas mensais de ${d}: esperado ${N_MESES} valores.`);
    if (!Array.isArray(f) || f.length !== N_MESES) throw new HttpError(400, `Faltas de ${d}: esperado ${N_MESES} valores.`);
    b.forEach((v, i) => { const x = nota(v); if (x !== null) linhas.bim.push([d, i, x]); });
    n.forEach((v, i) => { const x = nota(v); if (x !== null) linhas.notas.push([d, i, x]); });
    f.forEach((v, i) => { const x = falta(v, d); if (x !== null) linhas.faltas.push([d, i, x]); });
  }
  return linhas;
}

async function salvarAno(alunoId, ano, linhas) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT IGNORE INTO anos_letivos (ano) VALUES (?)', [ano]);
    for (const t of ['notas_bimestrais', 'notas_mensais', 'faltas_mensais']) {
      await conn.query(`DELETE FROM ${t} WHERE aluno_id=? AND ano=?`, [alunoId, ano]);
    }
    const com = rs => rs.map(r => [alunoId, ano, ...r]);
    if (linhas.bim.length) await conn.query('INSERT INTO notas_bimestrais (aluno_id, ano, disciplina, bimestre, nota) VALUES ?', [com(linhas.bim)]);
    if (linhas.notas.length) await conn.query('INSERT INTO notas_mensais (aluno_id, ano, disciplina, mes_idx, nota) VALUES ?', [com(linhas.notas)]);
    if (linhas.faltas.length) await conn.query('INSERT INTO faltas_mensais (aluno_id, ano, disciplina, mes_idx, faltas) VALUES ?', [com(linhas.faltas)]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Dados de demonstração (só se SEED_DEMO=true e o banco estiver vazio)
// ---------------------------------------------------------------------------
async function semearDemo() {
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM usuarios');
  if (total > 0) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT IGNORE INTO anos_letivos (ano) VALUES (2025), (2026)');

    const [r] = await conn.query(
      'INSERT INTO alunos (nome, email, turma, matricula) VALUES (?,?,?,?)',
      ['Maria Souza', 'aluno@escola.com.br', '8º Ano B', '2026-0142']);
    const alunoId = r.insertId;
    await criarDocumentosPendentes(conn, alunoId);

    const sit = ['entregue', 'entregue', 'entregue', 'entregue', 'entregue', 'analise', 'entregue', 'pendente'];
    const datas = ['2026-02-03', '2026-02-03', '2026-02-03', '2026-02-05', '2026-02-10', '2026-09-18', '2026-02-05', null];
    for (let i = 0; i < DOC_PADRAO.length; i++) {
      await conn.query('UPDATE documentos_aluno SET situacao=?, data_entrega=? WHERE aluno_id=? AND nome=?',
        [sit[i], datas[i], alunoId, DOC_PADRAO[i]]);
    }

    const hash = await bcrypt.hash('123456', 10);
    await conn.query('INSERT INTO usuarios (nome, email, senha_hash, perfil, aluno_id) VALUES (?,?,?,?,?)',
      ['Maria Souza', 'aluno@escola.com.br', hash, 'aluno', alunoId]);
    await conn.query('INSERT INTO usuarios (nome, email, senha_hash, perfil, aluno_id) VALUES (?,?,?,?,NULL)',
      ['Professor(a) Demonstração', 'professor@educonnect.com', hash, 'professor']);

    // Notas e faltas de 2025 e 2026 (mesmos números usados nas telas).
    const dados = {
      2025: {
        notas: { 'Português': [7.5, 8.0, 7.0, 8.5, 8.0, 7.5, 8.0, 9.0, 8.5, 9.0], 'Matemática': [6.0, 6.5, 7.0, 6.0, 5.5, 6.5, 7.0, 6.5, 7.5, 7.0], 'História': [8.5, 9.0, 8.0, 8.5, 9.0, 8.0, 8.5, 9.0, 8.5, 9.0], 'Ciências': [5.5, 6.0, 5.0, 6.5, 6.0, 5.5, 6.5, 7.0, 6.0, 6.5] },
        faltas: { 'Português': [0, 1, 0, 2, 1, 0, 1, 0, 2, 1], 'Matemática': [1, 0, 2, 2, 0, 1, 1, 0, 2, 2], 'História': [0, 0, 1, 0, 1, 0, 0, 1, 0, 0], 'Ciências': [1, 0, 1, 2, 2, 1, 0, 1, 1, 2] },
        bim: {}
      },
      2026: {
        notas: { 'Português': [8.0, 7.5, 8.5, 9.0, 8.0, 8.5, 9.0, null, null, null], 'Matemática': [6.5, 7.0, 6.0, 5.5, 6.5, 7.0, 6.0, null, null, null], 'História': [9.0, 8.5, 8.0, 9.0, 8.5, 8.0, 8.5, null, null, null], 'Ciências': [5.0, 6.0, 5.5, 4.5, 5.5, 6.0, 5.0, null, null, null] },
        faltas: { 'Português': [0, 0, 1, 0, 2, 1, 0, null, null, null], 'Matemática': [0, 1, 0, 1, 1, 0, 2, null, null, null], 'História': [0, 0, 0, 1, 0, 0, 1, null, null, null], 'Ciências': [1, 1, 0, 0, 2, 1, 0, null, null, null] },
        bim: { 'Português': [8.0, 7.5, 9.0], 'Matemática': [6.5, 7.0, 5.5], 'História': [9.0, 8.5, 8.0], 'Ciências': [5.0, 6.0, 4.5] }
      }
    };
    for (const [ano, d] of Object.entries(dados)) {
      for (const disc of DISC) {
        for (const [i, v] of (d.bim[disc] || []).entries()) await conn.query('INSERT INTO notas_bimestrais VALUES (?,?,?,?,?)', [alunoId, ano, disc, i, v]);
        for (const [i, v] of d.notas[disc].entries()) if (v !== null) await conn.query('INSERT INTO notas_mensais VALUES (?,?,?,?,?)', [alunoId, ano, disc, i, v]);
        for (const [i, v] of d.faltas[disc].entries()) if (v !== null) await conn.query('INSERT INTO faltas_mensais VALUES (?,?,?,?,?)', [alunoId, ano, disc, i, v]);
      }
    }
    await conn.commit();
    console.log('Dados de demonstração criados (aluno@escola.com.br / professor@educonnect.com, senha 123456).');
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Autenticação / autorização
// ---------------------------------------------------------------------------
function autenticar(req, _res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return next(new HttpError(401, 'Faça login para continuar.'));
  try {
    req.user = jwt.verify(m[1], JWT_SECRET); // { id, perfil, alunoId }
    next();
  } catch {
    next(new HttpError(401, 'Sessão expirada ou inválida. Entre novamente.'));
  }
}
const apenasProfessor = (req, _res, next) =>
  req.user.perfil === 'professor' ? next() : next(new HttpError(403, 'Acesso restrito a professores.'));

// Aluno só acessa o próprio registro; professor acessa qualquer um.
const acessoAoAluno = (req, _res, next) => {
  const id = idParam(req.params.id);
  if (req.user.perfil === 'professor' || req.user.alunoId === id) return next();
  next(new HttpError(403, 'Você não tem acesso aos dados deste aluno.'));
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // o alwaysdata fica atrás de um proxy (necessário para o rate limit)
app.use(helmet({ contentSecurityPolicy: false })); // as páginas usam scripts inline e CDN do Bootstrap
app.use(express.json({ limit: '100kb' }));

const origens = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
if (origens.length) app.use('/api', cors({ origin: origens }));

const limiteLogin = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' } });
const limitePublico = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas solicitações. Aguarde alguns minutos.' } });

const api = express.Router();

// ----- Saúde -----
api.get('/saude', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ----- Autenticação -----
api.post('/auth/login', limiteLogin, wrap(async (req, res) => {
  const email = texto(req.body?.email, 150, 'E-mail').toLowerCase();
  const senha = texto(req.body?.senha, 200, 'Senha');

  const [rows] = await pool.execute(
    `SELECT u.id, u.nome, u.email, u.senha_hash, u.perfil, u.aluno_id, a.turma, a.matricula
       FROM usuarios u LEFT JOIN alunos a ON a.id = u.aluno_id WHERE u.email = ?`, [email]);
  const u = rows[0];
  const ok = u && await bcrypt.compare(senha, u.senha_hash);
  if (!ok) throw new HttpError(401, 'E-mail ou senha incorretos.');

  const token = jwt.sign({ id: u.id, perfil: u.perfil, alunoId: u.aluno_id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({
    token,
    usuario: { id: u.id, alunoId: u.aluno_id, perfil: u.perfil, nome: u.nome, email: u.email, turma: u.turma, matricula: u.matricula }
  });
}));

// Página "esqueci minha senha": registra o pedido e responde sempre igual
// (não revela se o e-mail existe). O CPF é validado, mas não é gravado.
api.post('/auth/recuperar-senha', limitePublico, wrap(async (req, res) => {
  const email = texto(req.body?.email, 150, 'E-mail').toLowerCase();
  if (!emailValido(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  if (!cpfValido(req.body?.cpf)) throw new HttpError(400, 'Informe um CPF válido.');
  await pool.execute('INSERT INTO recuperacoes_senha (email) VALUES (?)', [email]);
  // TODO: enviar o e-mail com link de redefinição (ex.: nodemailer).
  res.status(202).json({ mensagem: 'Solicitação enviada! Se os dados estiverem corretos, você receberá as instruções por e-mail.' });
}));

// Troca de senha do usuário logado.
api.put('/auth/senha', autenticar, wrap(async (req, res) => {
  const atual = texto(req.body?.senhaAtual, 200, 'Senha atual');
  const nova = texto(req.body?.novaSenha, 200, 'Nova senha');
  if (nova.length < 8) throw new HttpError(400, 'A nova senha deve ter pelo menos 8 caracteres.');
  const [rows] = await pool.execute('SELECT senha_hash FROM usuarios WHERE id=?', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(atual, rows[0].senha_hash))) throw new HttpError(401, 'Senha atual incorreta.');
  await pool.execute('UPDATE usuarios SET senha_hash=? WHERE id=?', [await bcrypt.hash(nova, 10), req.user.id]);
  res.json({ mensagem: 'Senha alterada.' });
}));

// ----- Anos letivos -----
api.get('/anos', autenticar, wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT ano FROM anos_letivos ORDER BY ano DESC');
  res.json(rows.map(r => r.ano));
}));

api.post('/anos', autenticar, apenasProfessor, wrap(async (req, res) => {
  const ano = anoParam(req.body?.ano);
  const [r] = await pool.execute('INSERT IGNORE INTO anos_letivos (ano) VALUES (?)', [ano]);
  if (!r.affectedRows) throw new HttpError(409, 'Este ano letivo já existe.');
  res.status(201).json({ ano });
}));

// ----- Alunos (CRUD – painel do professor) -----
api.get('/alunos', autenticar, apenasProfessor, wrap(async (req, res) => {
  const busca = `%${String(req.query.busca || '').trim()}%`;
  const turma = String(req.query.turma || '').trim();
  const [rows] = await pool.execute(
    `SELECT id, nome, email, turma, matricula FROM alunos
      WHERE (nome LIKE ? OR matricula LIKE ?) AND (? = '' OR turma = ?)
      ORDER BY nome`, [busca, busca, turma, turma]);
  res.json(rows);
}));

api.get('/alunos/:id', autenticar, acessoAoAluno, wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT id, nome, email, turma, matricula FROM alunos WHERE id=?', [idParam(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Aluno não encontrado.');
  res.json(rows[0]);
}));

api.post('/alunos', autenticar, apenasProfessor, wrap(async (req, res) => {
  const nome = texto(req.body?.nome, 120, 'Nome');
  const email = texto(req.body?.email, 150, 'E-mail').toLowerCase();
  const turma = texto(req.body?.turma, 40, 'Turma');
  const matricula = texto(req.body?.matricula, 30, 'Matrícula');
  if (!emailValido(email)) throw new HttpError(400, 'Informe um e-mail válido.');

  // Senha provisória exibida uma única vez para o professor repassar ao aluno.
  const senhaTemporaria = crypto.randomBytes(5).toString('hex');
  const hash = await bcrypt.hash(senhaTemporaria, 10);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute('INSERT INTO alunos (nome, email, turma, matricula) VALUES (?,?,?,?)', [nome, email, turma, matricula]);
    await conn.execute('INSERT INTO usuarios (nome, email, senha_hash, perfil, aluno_id) VALUES (?,?,?,?,?)', [nome, email, hash, 'aluno', r.insertId]);
    await criarDocumentosPendentes(conn, r.insertId);
    await conn.commit();
    res.status(201).json({ id: r.insertId, nome, email, turma, matricula, senhaTemporaria });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

api.put('/alunos/:id', autenticar, apenasProfessor, wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const nome = texto(req.body?.nome, 120, 'Nome');
  const email = texto(req.body?.email, 150, 'E-mail').toLowerCase();
  const turma = texto(req.body?.turma, 40, 'Turma');
  const matricula = texto(req.body?.matricula, 30, 'Matrícula');
  if (!emailValido(email)) throw new HttpError(400, 'Informe um e-mail válido.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute('UPDATE alunos SET nome=?, email=?, turma=?, matricula=? WHERE id=?', [nome, email, turma, matricula, id]);
    if (!r.affectedRows) {
      const [ex] = await conn.execute('SELECT id FROM alunos WHERE id=?', [id]);
      if (!ex[0]) throw new HttpError(404, 'Aluno não encontrado.');
    }
    await conn.execute('UPDATE usuarios SET nome=?, email=? WHERE aluno_id=?', [nome, email, id]);
    await conn.commit();
    res.json({ id, nome, email, turma, matricula });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

api.delete('/alunos/:id', autenticar, apenasProfessor, wrap(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM alunos WHERE id=?', [idParam(req.params.id)]); // cascata apaga notas, faltas, docs e login
  if (!r.affectedRows) throw new HttpError(404, 'Aluno não encontrado.');
  res.status(204).end();
}));

// ----- Notas bimestrais, notas mensais e faltas de um ano -----
// Formato: { bim: {disc:[3]}, notas: {disc:[10]}, faltas: {disc:[10]} } (null = sem lançamento)
api.get('/alunos/:id/anos/:ano', autenticar, acessoAoAluno, wrap(async (req, res) => {
  res.json(await lerAno(idParam(req.params.id), anoParam(req.params.ano)));
}));

api.put('/alunos/:id/anos/:ano', autenticar, apenasProfessor, wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const ano = anoParam(req.params.ano);
  const [al] = await pool.execute('SELECT id FROM alunos WHERE id=?', [id]);
  if (!al[0]) throw new HttpError(404, 'Aluno não encontrado.');
  const linhas = validarAno(req.body); // valida tudo antes de gravar
  await salvarAno(id, ano, linhas);
  res.json(await lerAno(id, ano));
}));

api.delete('/alunos/:id/anos/:ano', autenticar, apenasProfessor, wrap(async (req, res) => {
  await salvarAno(idParam(req.params.id), anoParam(req.params.ano), { bim: [], notas: [], faltas: [] });
  res.status(204).end();
}));

// ----- Documentos do aluno -----
api.get('/alunos/:id/documentos', autenticar, acessoAoAluno, wrap(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT nome, situacao, data_entrega AS data FROM documentos_aluno WHERE aluno_id=?', [idParam(req.params.id)]);
  rows.sort((a, b) => DOC_PADRAO.indexOf(a.nome) - DOC_PADRAO.indexOf(b.nome));
  res.json(rows);
}));

// Corpo: [{ nome, situacao, data }, ...]
api.put('/alunos/:id/documentos', autenticar, apenasProfessor, wrap(async (req, res) => {
  const id = idParam(req.params.id);
  if (!Array.isArray(req.body)) throw new HttpError(400, 'Envie uma lista de documentos.');
  const hoje = new Date().toISOString().slice(0, 10);
  const linhas = req.body.map(d => {
    if (!DOC_PADRAO.includes(d?.nome)) throw new HttpError(400, `Documento desconhecido: ${d?.nome}.`);
    if (!SITUACOES.includes(d.situacao)) throw new HttpError(400, 'Situação de documento inválida.');
    const data = d.situacao === 'pendente' ? null : (dataISO(d.data) || hoje);
    return [id, d.nome, d.situacao, data];
  });
  if (!linhas.length) throw new HttpError(400, 'Nenhum documento informado.');
  const [al] = await pool.execute('SELECT id FROM alunos WHERE id=?', [id]);
  if (!al[0]) throw new HttpError(404, 'Aluno não encontrado.');
  await pool.query(
    `INSERT INTO documentos_aluno (aluno_id, nome, situacao, data_entrega) VALUES ?
     ON DUPLICATE KEY UPDATE situacao=VALUES(situacao), data_entrega=VALUES(data_entrega)`, [linhas]);
  const [rows] = await pool.execute('SELECT nome, situacao, data_entrega AS data FROM documentos_aluno WHERE aluno_id=?', [id]);
  rows.sort((a, b) => DOC_PADRAO.indexOf(a.nome) - DOC_PADRAO.indexOf(b.nome));
  res.json(rows);
}));

// ----- Secretaria: solicitações de documentos -----
// Criar é público (a página da secretaria não exige login).
api.post('/solicitacoes', limitePublico, wrap(async (req, res) => {
  const nome = texto(req.body?.nome, 120, 'Nome completo');
  const email = texto(req.body?.email, 150, 'E-mail').toLowerCase();
  if (!emailValido(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  const matricula = texto(req.body?.matricula, 30, 'Matrícula', false) || null;
  const documento = texto(req.body?.documento, 60, 'Documento desejado');
  if (!DOCS_SECRETARIA.includes(documento)) throw new HttpError(400, 'Documento desejado inválido.');
  const detalhes = texto(req.body?.detalhes, 1000, 'Detalhes', false) || null;

  const protocolo = 'EC-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  await pool.execute(
    'INSERT INTO solicitacoes (protocolo, nome, email, matricula, documento, detalhes) VALUES (?,?,?,?,?,?)',
    [protocolo, nome, email, matricula, documento, detalhes]);
  res.status(201).json({ protocolo });
}));

api.get('/solicitacoes', autenticar, apenasProfessor, wrap(async (req, res) => {
  const status = String(req.query.status || '');
  const [rows] = STATUS_SOLICITACAO.includes(status)
    ? await pool.execute('SELECT * FROM solicitacoes WHERE status=? ORDER BY criado_em DESC', [status])
    : await pool.query('SELECT * FROM solicitacoes ORDER BY criado_em DESC');
  res.json(rows);
}));

api.patch('/solicitacoes/:id', autenticar, apenasProfessor, wrap(async (req, res) => {
  const status = req.body?.status;
  if (!STATUS_SOLICITACAO.includes(status)) throw new HttpError(400, 'Status inválido.');
  const [r] = await pool.execute('UPDATE solicitacoes SET status=? WHERE id=?', [status, idParam(req.params.id)]);
  if (!r.affectedRows) throw new HttpError(404, 'Solicitação não encontrada.');
  res.json({ ok: true });
}));

api.delete('/solicitacoes/:id', autenticar, apenasProfessor, wrap(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM solicitacoes WHERE id=?', [idParam(req.params.id)]);
  if (!r.affectedRows) throw new HttpError(404, 'Solicitação não encontrada.');
  res.status(204).end();
}));

app.use('/api', api);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Rota não encontrada.')));

// ----- Frontend estático (opcional) -----
if (FRONTEND_DIR) {
  const raiz = path.resolve(__dirname, FRONTEND_DIR);
  app.use(express.static(raiz));
  app.get('/', (_req, res) => res.sendFile(path.join(raiz, 'Indexescola.html')));
}

// ----- Tratamento central de erros -----
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ erro: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.code === 'ER_DUP_ENTRY') {
    const campo = /matricula/i.test(err.message) ? 'matrícula' : 'e-mail';
    return res.status(409).json({ erro: `Já existe um registro com esta ${campo}.` });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
(async () => {
  try {
    await criarTabelas();
    if (SEED_DEMO === 'true') await semearDemo();
  } catch (e) {
    console.error('Falha ao preparar o banco de dados:', e.message);
    process.exit(1);
  }
  // No alwaysdata, PORT e IP vêm do ambiente; localmente usa 3000.
  const porta = Number(process.env.PORT) || 3000;
  const ip = process.env.IP || '0.0.0.0';
  app.listen(porta, ip, () => console.log(`EduConnect API em http://${ip}:${porta}`));
})();
