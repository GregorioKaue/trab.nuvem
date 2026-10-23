require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../db");

(async () => {
  const { ADMIN_NOME, ADMIN_EMAIL, ADMIN_SENHA } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_SENHA) {
    console.error("Defina ADMIN_EMAIL e ADMIN_SENHA no .env");
    process.exit(1);
  }
  const hash = await bcrypt.hash(ADMIN_SENHA, 12);
  await pool.execute(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil)
     VALUES (?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE senha_hash = VALUES(senha_hash), perfil = 'admin'`,
    [ADMIN_NOME || "Administrador", ADMIN_EMAIL.toLowerCase(), hash]
  );
  console.log("Administrador criado/atualizado:", ADMIN_EMAIL);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
