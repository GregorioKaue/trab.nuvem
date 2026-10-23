CREATE DATABASE IF NOT EXISTS educonnect
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE educonnect;

CREATE TABLE IF NOT EXISTS usuarios (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nome        VARCHAR(120) NOT NULL,
  email       VARCHAR(160) NOT NULL UNIQUE,
  senha_hash  VARCHAR(100) NOT NULL,
  perfil      ENUM('aluno','professor','admin') NOT NULL DEFAULT 'aluno',
  ativo       TINYINT(1) NOT NULL DEFAULT 1,
  criado_em   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Cards da página: "ferramenta" (seção Ferramentas digitais)
-- e "academico" (seção Sistemas acadêmicos).
CREATE TABLE IF NOT EXISTS recursos (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  categoria   ENUM('ferramenta','academico') NOT NULL,
  nome        VARCHAR(100) NOT NULL,
  descricao   VARCHAR(255) NOT NULL,
  icone       VARCHAR(16)  NOT NULL DEFAULT '🔗',
  url         VARCHAR(500) NULL,            -- endereço oficial do sistema
  ordem       SMALLINT NOT NULL DEFAULT 0,
  ativo       TINYINT(1) NOT NULL DEFAULT 1,
  criado_em   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_categoria (categoria, ativo, ordem),
  FULLTEXT KEY ft_busca (nome, descricao)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS documentos (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  usuario_id     INT UNSIGNED NOT NULL,
  nome_original  VARCHAR(255) NOT NULL,
  nome_arquivo   VARCHAR(100) NOT NULL UNIQUE,   -- nome aleatório em disco
  mime           VARCHAR(120) NOT NULL,
  tamanho        INT UNSIGNED NOT NULL,
  criado_em      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_doc_usuario FOREIGN KEY (usuario_id)
    REFERENCES usuarios(id) ON DELETE CASCADE,
  INDEX idx_doc_usuario (usuario_id, criado_em)
) ENGINE=InnoDB;

INSERT INTO recursos (categoria, nome, descricao, icone, ordem) VALUES
 ('ferramenta','Sala de aula virtual','Acesse aulas, atividades e materiais didáticos.','📚',1),
 ('ferramenta','Videoconferências','Entre em reuniões e aulas ao vivo.','🎥',2),
 ('ferramenta','Atividades','Consulte tarefas e organize seus estudos.','📝',3),
 ('ferramenta','Colaboração','Compartilhe ideias e trabalhe em equipe.','🤝',4),
 ('academico','Notas e boletim','Consulte seu desempenho.','📊',1),
 ('academico','Frequência','Acompanhe suas presenças.','📅',2),
 ('academico','Secretaria','Serviços administrativos.','🏫',3);
