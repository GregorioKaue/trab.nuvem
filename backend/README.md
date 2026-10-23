# EduConnect — Backend (Node.js + MySQL no alwaysdata)

## 1. Banco de dados no alwaysdata
1. Painel alwaysdata → **Bancos de dados → MySQL → Adicionar um banco** (ex.: `SUACONTA_educonnect`).
2. Em **Usuários**, crie um usuário com permissão total nesse banco.
3. Anote o host (`mysql-SUACONTA.alwaysdata.net`), usuário, senha e nome do banco.

As tabelas são criadas automaticamente na primeira execução.

## 2. Rodando
```bash
cp .env.example .env     # preencha DB_*, JWT_SECRET e CORS_ORIGIN
npm install
npm start
```
Teste: `GET /api/saude` deve retornar `{"ok":true}`.

> Para testar do seu computador, o alwaysdata precisa aceitar conexão remota ao MySQL
> (por padrão aceita; confira a opção de acesso remoto/IP no painel).

## 3. Publicando no alwaysdata
1. Envie o backend (sem `.env` e `node_modules`) por SSH/SFTP/Git, por exemplo para `~/educonnect/backend`.
2. Envie o site (`Indexescola.html` e `pages/`) para outra pasta, por exemplo `~/educonnect/site`.
3. No SSH: `cd ~/educonnect/backend && npm install --omit=dev` e crie o `.env`.
4. **Web → Sites → Adicionar**: tipo **Node.js**, comando `node server.js`, pasta de trabalho do backend.
   O alwaysdata define `PORT` e `IP` automaticamente.
5. Em `.env`, `FRONTEND_DIR=../site` faz o Node servir o site e a API no mesmo endereço (sem problemas de CORS).
6. Após o primeiro acesso, ponha `SEED_DEMO=false`.

## 4. Rotas
| Método | Rota | Quem | Uso |
|---|---|---|---|
| POST | `/api/auth/login` | público | `{email, senha}` → `{token, usuario}` |
| POST | `/api/auth/recuperar-senha` | público | `{email, cpf}` |
| PUT | `/api/auth/senha` | logado | `{senhaAtual, novaSenha}` |
| GET/POST | `/api/anos` | logado / professor | lista / cria ano letivo `{ano}` |
| GET/POST | `/api/alunos` | professor | lista (`?busca=&turma=`) / cadastra |
| GET | `/api/alunos/:id` | aluno (próprio) ou professor | dados do aluno |
| PUT/DELETE | `/api/alunos/:id` | professor | edita / exclui |
| GET | `/api/alunos/:id/anos/:ano` | aluno (próprio) ou professor | `{bim, notas, faltas}` |
| PUT/DELETE | `/api/alunos/:id/anos/:ano` | professor | grava / limpa lançamentos do ano |
| GET | `/api/alunos/:id/documentos` | aluno (próprio) ou professor | documentos |
| PUT | `/api/alunos/:id/documentos` | professor | `[{nome, situacao, data}]` |
| POST | `/api/solicitacoes` | público | formulário da secretaria → `{protocolo}` |
| GET/PATCH/DELETE | `/api/solicitacoes[/:id]` | professor | acompanhar / mudar status / apagar |

Rotas protegidas exigem o cabeçalho `Authorization: Bearer <token>`.

## 5. Como ligar o frontend
Em cada página, troque os dados fixos por chamadas `fetch`. Exemplo de login (`login.html`):

```js
const resp = await fetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: email.value.trim(), senha: senha.value })
});
const dados = await resp.json();
if (!resp.ok) { /* mostrar dados.erro */ }
else {
  sessionStorage.setItem("token", dados.token);
  if (dados.usuario.perfil === "professor") {
    sessionStorage.setItem("professorLogado", JSON.stringify(dados.usuario));
    location.href = "painel-professor.html";
  } else {
    sessionStorage.setItem("usuarioLogado", JSON.stringify(dados.usuario));
    location.href = "perfil.html";
  }
}
```

Exemplo autenticado (perfil/desempenho do aluno):

```js
const token = sessionStorage.getItem("token");
const r = await fetch(`/api/alunos/${usuario.alunoId}/anos/2026`, {
  headers: { Authorization: "Bearer " + token }
});
const { bim, notas, faltas } = await r.json(); // mesmo formato do objeto DADOS
```

No painel do professor, "Salvar alterações" vira `PUT /api/alunos/:id/anos/:ano` (corpo `{bim, notas, faltas}`) e `PUT /api/alunos/:id/documentos`.

## 6. Segurança
- Senhas com bcrypt; sessão por JWT; limite de tentativas no login.
- Todas as consultas usam parâmetros (`?`), sem concatenar texto do usuário em SQL.
- Alunos só enxergam os próprios dados; só professores alteram notas, faltas e documentos.
- O CPF da recuperação de senha é validado, mas não é gravado.
- Mantenha o backend **fora** da pasta do site, para o `.env` nunca ficar acessível por URL.
- Troque as senhas de demonstração (`123456`) antes de usar com dados reais.
