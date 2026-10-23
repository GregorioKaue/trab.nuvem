-- =====================================================================
-- EduConnect - Banco de dados MySQL 8.0.16+ (necessário para CHECK)
-- Atende: perfil.html (aluno) e painel-professor.html (professor)
-- =====================================================================

DROP DATABASE IF EXISTS educonnect; -- Apaga o banco se já existir (cuidado: perde os dados!)
CREATE DATABASE educonnect CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; -- Cria o banco com suporte a acentos e emojis
USE educonnect; -- Passa a usar o banco recém-criado

-- ---------------------------------------------------------------------
-- 1. USUÁRIOS (login de alunos e professores)
--    A senha NUNCA é guardada em texto puro: grave o hash (bcrypt/argon2)
--    gerado pelo back-end.
-- ---------------------------------------------------------------------
CREATE TABLE usuarios ( -- Tabela de contas de acesso
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,  -- Identificador único, gerado automaticamente
  nome        VARCHAR(120) NOT NULL,                    -- Nome completo
  email       VARCHAR(150) NOT NULL UNIQUE,             -- E-mail de login (não pode repetir)
  senha_hash  VARCHAR(255) NOT NULL,                    -- Senha criptografada (hash)
  perfil      ENUM('aluno','professor','admin') NOT NULL, -- Tipo de conta: define qual página a pessoa acessa
  ativo       TINYINT(1) NOT NULL DEFAULT 1,            -- 1 = conta ativa, 0 = bloqueada
  criado_em   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP -- Data de criação, preenchida automaticamente
) ENGINE=InnoDB; -- Motor que suporta chaves estrangeiras e transações

-- ---------------------------------------------------------------------
-- 2. ESTRUTURA ESCOLAR
-- ---------------------------------------------------------------------
CREATE TABLE anos_letivos ( -- Anos letivos cadastrados (botão "+ Ano" do painel)
  ano  SMALLINT UNSIGNED PRIMARY KEY -- Ex.: 2026
) ENGINE=InnoDB;

CREATE TABLE turmas ( -- Turmas de cada ano letivo
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Identificador da turma
  nome         VARCHAR(60) NOT NULL,                    -- Ex.: '8º Ano A'
  ano_letivo   SMALLINT UNSIGNED NOT NULL,              -- Ano a que a turma pertence
  UNIQUE KEY uq_turma_ano (nome, ano_letivo),           -- Não pode haver duas turmas com o mesmo nome no mesmo ano
  FOREIGN KEY (ano_letivo) REFERENCES anos_letivos(ano) -- O ano precisa existir em anos_letivos
) ENGINE=InnoDB;

CREATE TABLE disciplinas ( -- Disciplinas oferecidas
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Identificador da disciplina
  nome            VARCHAR(80) NOT NULL UNIQUE,             -- Nome (não repete)
  aulas_por_mes   TINYINT UNSIGNED NOT NULL,               -- Total de aulas no mês (limite de faltas)
  CHECK (aulas_por_mes > 0)                                -- Precisa ser maior que zero
) ENGINE=InnoDB;

CREATE TABLE professores ( -- Complementa o usuário que é professor
  usuario_id  INT UNSIGNED PRIMARY KEY,                                  -- Mesmo id da tabela usuarios
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE     -- Apagar o usuário apaga o professor
) ENGINE=InnoDB;

-- Define quem pode lançar dados de qual disciplina em qual turma.
CREATE TABLE professor_turma_disciplina (
  professor_id   INT UNSIGNED NOT NULL, -- Professor
  turma_id       INT UNSIGNED NOT NULL, -- Turma em que leciona
  disciplina_id  INT UNSIGNED NOT NULL, -- Disciplina que leciona
  PRIMARY KEY (professor_id, turma_id, disciplina_id),                       -- A combinação não pode repetir
  FOREIGN KEY (professor_id)  REFERENCES professores(usuario_id) ON DELETE CASCADE, -- Vínculo com o professor
  FOREIGN KEY (turma_id)      REFERENCES turmas(id)              ON DELETE CASCADE, -- Vínculo com a turma
  FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id)         ON DELETE CASCADE  -- Vínculo com a disciplina
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. ALUNOS E MATRÍCULAS ANUAIS
--    "alunos" guarda a pessoa; "matriculas" liga o aluno a uma turma em
--    cada ano letivo (por isso o seletor de ano letivo funciona).
-- ---------------------------------------------------------------------
CREATE TABLE alunos ( -- Complementa o usuário que é aluno
  usuario_id  INT UNSIGNED PRIMARY KEY,   -- Mesmo id da tabela usuarios
  matricula   VARCHAR(20) NOT NULL UNIQUE, -- Número de matrícula (não repete)
  foto        MEDIUMBLOB NULL,             -- Foto de perfil (opcional; pode ser trocada por um caminho de arquivo)
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE -- Apagar o usuário apaga o aluno
) ENGINE=InnoDB;

CREATE TABLE matriculas ( -- Matrícula do aluno em uma turma, em um ano
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Identificador da matrícula
  aluno_id    INT UNSIGNED NOT NULL,                   -- Aluno
  turma_id    INT UNSIGNED NOT NULL,                   -- Turma
  ano_letivo  SMALLINT UNSIGNED NOT NULL,              -- Ano letivo
  UNIQUE KEY uq_aluno_ano (aluno_id, ano_letivo),      -- Um aluno só pode ter uma matrícula por ano
  FOREIGN KEY (aluno_id)   REFERENCES alunos(usuario_id) ON DELETE CASCADE, -- Apagar o aluno apaga suas matrículas
  FOREIGN KEY (turma_id)   REFERENCES turmas(id),                           -- A turma precisa existir
  FOREIGN KEY (ano_letivo) REFERENCES anos_letivos(ano)                     -- O ano precisa existir
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. NOTAS E FREQUÊNCIA
--    Sem linha (ou nota NULL) = ainda não lançado ("—" no perfil).
--    Meses letivos: 2 a 12, exceto 7 (recesso).
-- ---------------------------------------------------------------------
CREATE TABLE notas_bimestrais ( -- Tabela "Minhas notas" do perfil
  matricula_id   INT UNSIGNED NOT NULL,  -- Matrícula do aluno no ano
  disciplina_id  INT UNSIGNED NOT NULL,  -- Disciplina
  bimestre       TINYINT UNSIGNED NOT NULL, -- Número do bimestre (1 a 4)
  nota           DECIMAL(3,1) NULL,      -- Nota com uma casa decimal (ex.: 8.5); NULL = não lançada
  lancado_por    INT UNSIGNED NULL,      -- Professor que lançou
  atualizado_em  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- Data da última alteração (automática)
  PRIMARY KEY (matricula_id, disciplina_id, bimestre), -- Uma nota por matrícula/disciplina/bimestre
  CHECK (bimestre BETWEEN 1 AND 4),                    -- Bimestre válido
  CHECK (nota IS NULL OR nota BETWEEN 0 AND 10),       -- Nota entre 0 e 10
  FOREIGN KEY (matricula_id)  REFERENCES matriculas(id)  ON DELETE CASCADE,        -- Apagar a matrícula apaga as notas
  FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id),                          -- Disciplina precisa existir
  FOREIGN KEY (lancado_por)   REFERENCES professores(usuario_id) ON DELETE SET NULL -- Se o professor sair, mantém a nota e zera o autor
) ENGINE=InnoDB;

CREATE TABLE notas_mensais ( -- Notas por mês (seção "Notas por ano, semestre e mês")
  matricula_id   INT UNSIGNED NOT NULL,  -- Matrícula
  disciplina_id  INT UNSIGNED NOT NULL,  -- Disciplina
  mes            TINYINT UNSIGNED NOT NULL, -- Mês: 2 = Fev ... 12 = Dez (7 não existe)
  nota           DECIMAL(3,1) NULL,      -- Nota do mês
  lancado_por    INT UNSIGNED NULL,      -- Professor que lançou
  atualizado_em  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- Última alteração
  PRIMARY KEY (matricula_id, disciplina_id, mes),     -- Uma nota por matrícula/disciplina/mês
  CHECK (mes BETWEEN 2 AND 12 AND mes <> 7),          -- Mês letivo válido (julho é recesso)
  CHECK (nota IS NULL OR nota BETWEEN 0 AND 10),      -- Nota entre 0 e 10
  FOREIGN KEY (matricula_id)  REFERENCES matriculas(id)  ON DELETE CASCADE,
  FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id),
  FOREIGN KEY (lancado_por)   REFERENCES professores(usuario_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE frequencia_mensal ( -- Faltas por mês (seção "Frequência escolar")
  matricula_id   INT UNSIGNED NOT NULL,  -- Matrícula
  disciplina_id  INT UNSIGNED NOT NULL,  -- Disciplina
  mes            TINYINT UNSIGNED NOT NULL, -- Mês letivo
  faltas         TINYINT UNSIGNED NOT NULL, -- Nº de faltas; a linha só existe se o mês já aconteceu
  lancado_por    INT UNSIGNED NULL,      -- Professor que lançou
  atualizado_em  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- Última alteração
  PRIMARY KEY (matricula_id, disciplina_id, mes),     -- Um registro por matrícula/disciplina/mês
  CHECK (mes BETWEEN 2 AND 12 AND mes <> 7),          -- Mês letivo válido
  FOREIGN KEY (matricula_id)  REFERENCES matriculas(id)  ON DELETE CASCADE,
  FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id),
  FOREIGN KEY (lancado_por)   REFERENCES professores(usuario_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 5. DOCUMENTOS
-- ---------------------------------------------------------------------
CREATE TABLE tipos_documento ( -- Lista de documentos exigidos pela escola
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Identificador
  nome         VARCHAR(100) NOT NULL UNIQUE,            -- Ex.: 'RG do aluno'
  obrigatorio  TINYINT(1) NOT NULL DEFAULT 1            -- 1 = exigido de todos os alunos
) ENGINE=InnoDB;

CREATE TABLE documentos_aluno ( -- Situação de cada documento de cada aluno
  aluno_id       INT UNSIGNED NOT NULL, -- Aluno
  tipo_id        INT UNSIGNED NOT NULL, -- Tipo de documento
  situacao       ENUM('entregue','analise','pendente') NOT NULL DEFAULT 'pendente', -- Situação atual
  data_entrega   DATE NULL,             -- Data de entrega (NULL se pendente)
  arquivo        VARCHAR(255) NULL,     -- Caminho do arquivo enviado em documentos.html
  atualizado_por INT UNSIGNED NULL,     -- Quem fez a última alteração
  atualizado_em  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- Última alteração
  PRIMARY KEY (aluno_id, tipo_id),      -- Um registro por aluno e tipo de documento
  CHECK ((situacao = 'pendente' AND data_entrega IS NULL) OR (situacao <> 'pendente' AND data_entrega IS NOT NULL)), -- Pendente não tem data; os demais têm
  FOREIGN KEY (aluno_id) REFERENCES alunos(usuario_id) ON DELETE CASCADE, -- Apagar o aluno apaga seus documentos
  FOREIGN KEY (tipo_id)  REFERENCES tipos_documento(id),                  -- O tipo precisa existir
  FOREIGN KEY (atualizado_por) REFERENCES usuarios(id) ON DELETE SET NULL -- Mantém o registro se o usuário for removido
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 6. HISTÓRICO DE ALTERAÇÕES (quem mudou o quê)
-- ---------------------------------------------------------------------
CREATE TABLE log_alteracoes ( -- Registro de auditoria
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Identificador do registro
  usuario_id    INT UNSIGNED NULL,                          -- Quem fez a alteração
  tabela        VARCHAR(40) NOT NULL,                       -- Tabela alterada
  descricao     VARCHAR(255) NOT NULL,                      -- O que mudou
  criado_em     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, -- Quando mudou
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Trigger de exemplo: registra toda alteração de nota bimestral.
DELIMITER // -- Troca o fim de comando para // (o trigger tem vários ";" dentro)
CREATE TRIGGER trg_log_nota_bim AFTER UPDATE ON notas_bimestrais -- Dispara depois de cada UPDATE nessa tabela
FOR EACH ROW -- Executa uma vez para cada linha alterada
BEGIN
  IF NOT (OLD.nota <=> NEW.nota) THEN -- Só registra se a nota realmente mudou (<=> compara também NULL)
    INSERT INTO log_alteracoes (usuario_id, tabela, descricao) -- Grava no histórico
    VALUES (NEW.lancado_por, 'notas_bimestrais', -- Autor e tabela
            CONCAT('Matrícula ', NEW.matricula_id, ', disciplina ', NEW.disciplina_id, -- Texto descrevendo a mudança
                   ', bimestre ', NEW.bimestre, ': ', IFNULL(OLD.nota,'—'), ' -> ', IFNULL(NEW.nota,'—')));
  END IF; -- Fim da condição
END// -- Fim do trigger
DELIMITER ; -- Volta ao fim de comando normal (;)

-- ---------------------------------------------------------------------
-- 7. VIEWS usadas pelo perfil.html (cartões-resumo e tabelas)
-- ---------------------------------------------------------------------
-- Frequência geral por matrícula: (aulas - faltas) / aulas
CREATE VIEW vw_frequencia_geral AS
SELECT f.matricula_id, -- Matrícula
       SUM(d.aulas_por_mes) AS total_aulas, -- Soma das aulas dos meses já lançados
       SUM(f.faltas)        AS total_faltas, -- Soma das faltas
       ROUND((SUM(d.aulas_por_mes) - SUM(f.faltas)) / SUM(d.aulas_por_mes) * 100, 1) AS frequencia_pct -- Percentual de presença
FROM frequencia_mensal f
JOIN disciplinas d ON d.id = f.disciplina_id -- Traz as aulas por mês de cada disciplina
GROUP BY f.matricula_id; -- Um resultado por matrícula

-- Média geral das notas mensais (ignora meses sem nota)
CREATE VIEW vw_media_geral AS
SELECT matricula_id, ROUND(AVG(nota), 1) AS media_geral -- Média com uma casa decimal
FROM notas_mensais
WHERE nota IS NOT NULL -- Ignora notas não lançadas
GROUP BY matricula_id;

-- Média por disciplina nas notas bimestrais + situação
CREATE VIEW vw_notas_bimestrais_resumo AS
SELECT nb.matricula_id, d.nome AS disciplina, -- Matrícula e nome da disciplina
       MAX(CASE WHEN nb.bimestre = 1 THEN nb.nota END) AS bim1, -- Nota do 1º bimestre
       MAX(CASE WHEN nb.bimestre = 2 THEN nb.nota END) AS bim2, -- Nota do 2º bimestre
       MAX(CASE WHEN nb.bimestre = 3 THEN nb.nota END) AS bim3, -- Nota do 3º bimestre
       ROUND(AVG(nb.nota), 1) AS media, -- Média das notas
       CASE WHEN AVG(nb.nota) >= 6 THEN 'Aprovado' ELSE 'Recuperação' END AS situacao -- Média mínima: 6
FROM notas_bimestrais nb
JOIN disciplinas d ON d.id = nb.disciplina_id
GROUP BY nb.matricula_id, d.nome;

-- ---------------------------------------------------------------------
-- 8. DADOS INICIAIS
-- ---------------------------------------------------------------------
INSERT INTO anos_letivos (ano) VALUES (2025), (2026); -- Anos letivos

INSERT INTO disciplinas (nome, aulas_por_mes) VALUES -- Disciplinas e aulas por mês
  ('Português', 16), -- id 1
  ('Matemática', 16), -- id 2
  ('História', 8),   -- id 3
  ('Ciências', 8);   -- id 4

INSERT INTO tipos_documento (nome) VALUES -- Documentos exigidos
  ('Certidão de nascimento'), ('RG do aluno'), ('CPF do aluno'), ('Comprovante de residência'), -- ids 1 a 4
  ('Histórico escolar'), ('Cartão de vacinação'), ('Foto 3x4'), ('Termo de autorização de imagem'); -- ids 5 a 8

INSERT INTO turmas (nome, ano_letivo) VALUES ('8º Ano A', 2025), ('8º Ano A', 2026); -- Turma 1 (2025) e turma 2 (2026)

-- ATENÇÃO: os hashes abaixo são apenas marcadores. Gere hashes reais no back-end.
INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES
  ('Professor Demonstração', 'professor@educonnect.com', '$2y$10$TROQUE_ESTE_HASH_PROFESSOR', 'professor'), -- Usuário 1
  ('Ana Souza',              'ana@aluno.educonnect.com', '$2y$10$TROQUE_ESTE_HASH_ANA',       'aluno');     -- Usuário 2

INSERT INTO professores (usuario_id) VALUES (1);            -- O usuário 1 é professor
INSERT INTO alunos (usuario_id, matricula) VALUES (2, '2026001'); -- O usuário 2 é aluno, matrícula 2026001

INSERT INTO professor_turma_disciplina (professor_id, turma_id, disciplina_id) -- Professor leciona todas as disciplinas em todas as turmas
SELECT 1, t.id, d.id FROM turmas t CROSS JOIN disciplinas d; -- CROSS JOIN gera todas as combinações

INSERT INTO matriculas (aluno_id, turma_id, ano_letivo) VALUES (2, 1, 2025), (2, 2, 2026); -- Ana: matrícula 1 (2025) e matrícula 2 (2026)

-- Notas bimestrais de 2026 da Ana (matrícula 2): (matrícula, disciplina, bimestre, nota, professor)
INSERT INTO notas_bimestrais (matricula_id, disciplina_id, bimestre, nota, lancado_por) VALUES
  (2,1,1,8.0,1),(2,1,2,7.5,1),(2,1,3,9.0,1), -- Português
  (2,2,1,6.5,1),(2,2,2,7.0,1),(2,2,3,5.5,1), -- Matemática
  (2,3,1,9.0,1),(2,3,2,8.5,1),(2,3,3,8.0,1), -- História
  (2,4,1,5.0,1),(2,4,2,6.0,1),(2,4,3,4.5,1); -- Ciências

-- Notas mensais de 2026 (Fev a Set) | meses: 2,3,4,5,6,8,9
INSERT INTO notas_mensais (matricula_id, disciplina_id, mes, nota, lancado_por) VALUES
  (2,1,2,8.0,1),(2,1,3,7.5,1),(2,1,4,8.5,1),(2,1,5,9.0,1),(2,1,6,8.0,1),(2,1,8,8.5,1),(2,1,9,9.0,1), -- Português
  (2,2,2,6.5,1),(2,2,3,7.0,1),(2,2,4,6.0,1),(2,2,5,5.5,1),(2,2,6,6.5,1),(2,2,8,7.0,1),(2,2,9,6.0,1), -- Matemática
  (2,3,2,9.0,1),(2,3,3,8.5,1),(2,3,4,8.0,1),(2,3,5,9.0,1),(2,3,6,8.5,1),(2,3,8,8.0,1),(2,3,9,8.5,1), -- História
  (2,4,2,5.0,1),(2,4,3,6.0,1),(2,4,4,5.5,1),(2,4,5,4.5,1),(2,4,6,5.5,1),(2,4,8,6.0,1),(2,4,9,5.0,1); -- Ciências

-- Faltas de 2026 (Fev a Set)
INSERT INTO frequencia_mensal (matricula_id, disciplina_id, mes, faltas, lancado_por) VALUES
  (2,1,2,0,1),(2,1,3,0,1),(2,1,4,1,1),(2,1,5,0,1),(2,1,6,2,1),(2,1,8,1,1),(2,1,9,0,1), -- Português
  (2,2,2,0,1),(2,2,3,1,1),(2,2,4,0,1),(2,2,5,1,1),(2,2,6,1,1),(2,2,8,0,1),(2,2,9,2,1), -- Matemática
  (2,3,2,0,1),(2,3,3,0,1),(2,3,4,0,1),(2,3,5,1,1),(2,3,6,0,1),(2,3,8,0,1),(2,3,9,1,1), -- História
  (2,4,2,1,1),(2,4,3,1,1),(2,4,4,0,1),(2,4,5,0,1),(2,4,6,2,1),(2,4,8,1,1),(2,4,9,0,1); -- Ciências

-- Documentos da Ana: (aluno, tipo, situação, data, quem atualizou)
INSERT INTO documentos_aluno (aluno_id, tipo_id, situacao, data_entrega, atualizado_por) VALUES
  (2,1,'entregue','2026-02-03',1), (2,2,'entregue','2026-02-03',1), -- Certidão e RG
  (2,3,'entregue','2026-02-03',1), (2,4,'entregue','2026-02-05',1), -- CPF e comprovante de residência
  (2,5,'entregue','2026-02-10',1), (2,6,'analise', '2026-09-18',1), -- Histórico e vacinação (em análise)
  (2,7,'entregue','2026-02-05',1), (2,8,'pendente', NULL,       1); -- Foto 3x4 e termo de imagem (pendente)

-- ---------------------------------------------------------------------
-- 9. CONSULTAS PRONTAS (comentadas: copie e troque os "?" pelos valores)
-- ---------------------------------------------------------------------
-- 9.1 Quando o PROFESSOR clica em "Salvar": use UPSERT (insere ou atualiza)
--     Nota mensal:
-- INSERT INTO notas_mensais (matricula_id, disciplina_id, mes, nota, lancado_por) -- Tenta inserir
-- VALUES (?, ?, ?, ?, ?)
-- ON DUPLICATE KEY UPDATE nota = VALUES(nota), lancado_por = VALUES(lancado_por); -- Se já existe, atualiza
--     Campo apagado (mês ainda não ocorreu) em frequência:
-- DELETE FROM frequencia_mensal WHERE matricula_id = ? AND disciplina_id = ? AND mes = ?; -- Remove o lançamento
--     Documento:
-- INSERT INTO documentos_aluno (aluno_id, tipo_id, situacao, data_entrega, atualizado_por)
-- VALUES (?, ?, ?, ?, ?)
-- ON DUPLICATE KEY UPDATE situacao = VALUES(situacao), data_entrega = VALUES(data_entrega),
--                         atualizado_por = VALUES(atualizado_por);

-- 9.2 Cabeçalho do PERFIL do aluno logado (por e-mail) em um ano letivo:
-- SELECT u.nome, u.email, a.matricula, t.nome AS turma, m.id AS matricula_id -- Dados exibidos no topo do perfil
-- FROM usuarios u
-- JOIN alunos a      ON a.usuario_id = u.id                                  -- Liga usuário ao aluno
-- JOIN matriculas m  ON m.aluno_id = a.usuario_id AND m.ano_letivo = 2026    -- Matrícula do ano escolhido
-- JOIN turmas t      ON t.id = m.turma_id                                    -- Nome da turma
-- WHERE u.email = 'ana@aluno.educonnect.com';

-- 9.3 Cartões-resumo do perfil:
-- SELECT f.frequencia_pct, g.media_geral
-- FROM vw_frequencia_geral f JOIN vw_media_geral g USING (matricula_id)
-- WHERE f.matricula_id = 2;

-- 9.4 Tabela "Minhas notas":
-- SELECT * FROM vw_notas_bimestrais_resumo WHERE matricula_id = 2;

-- 9.5 Documentos do aluno:
-- SELECT td.nome, da.situacao, da.data_entrega
-- FROM tipos_documento td
-- LEFT JOIN documentos_aluno da ON da.tipo_id = td.id AND da.aluno_id = 2; -- LEFT JOIN mostra também os que faltam
