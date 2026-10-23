# EduConnect — API + MySQL

## Requisitos
Node.js 18+ e MySQL 8+.

## Instalação
```bash
npm install
cp .env.example .env          # edite com suas credenciais e um JWT_SECRET forte
mysql -u root -p < schema.sql # cria banco, tabelas e cards iniciais
# crie o usuário do banco conforme o .env, por exemplo:
#   CREATE USER 'educonnect'@'localhost' IDENTIFIED BY 'sua_senha';
#   GRANT ALL ON educonnect.* TO 'educonnect'@'localhost';
npm run seed                  # cria o administrador inicial
npm start                     # http://localhost:3000
```

## Endpoints
| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| POST | /api/auth/login | público | Retorna JWT |
| GET | /api/auth/me | logado | Dados do token |
| POST | /api/usuarios | admin | Cadastra usuário |
| GET | /api/recursos?categoria=&q= | público | Lista/pesquisa cards |
| POST/PUT/DELETE | /api/recursos[/:id] | admin | Gerencia cards e URLs oficiais |
| GET | /api/documentos | logado | Lista (próprios; admin vê todos) |
| POST | /api/documentos | logado | Upload (campo `arquivos`) |
| GET | /api/documentos/:id/download | dono/admin | Baixa arquivo |
| DELETE | /api/documentos/:id | dono/admin | Exclui |

## Configurar os links oficiais (admin)
```bash
curl -X PUT http://localhost:3000/api/recursos/1 \
  -H "Authorization: Bearer SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://classroom.google.com"}'
```
