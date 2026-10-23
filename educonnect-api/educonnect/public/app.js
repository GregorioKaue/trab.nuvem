/* EduConnect — front-end integrado à API */
const $ = id => document.getElementById(id);
let sessao = JSON.parse(localStorage.getItem("sessao") || "null");

/* ---------- Cliente da API ---------- */
async function api(caminho, opcoes = {}) {
  const headers = { ...(opcoes.headers || {}) };
  if (sessao) headers.Authorization = "Bearer " + sessao.token;
  if (opcoes.body && !(opcoes.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    opcoes.body = JSON.stringify(opcoes.body);
  }
  const resp = await fetch("/api" + caminho, { ...opcoes, headers });
  if (resp.status === 401 && sessao) { sair(); }
  if (!resp.ok) {
    const dados = await resp.json().catch(() => ({}));
    throw new Error(dados.erro || "Erro " + resp.status);
  }
  return resp;
}
const json = async (caminho, opcoes) => (await api(caminho, opcoes)).json();

/* ---------- Recursos (ferramentas e sistemas acadêmicos) ---------- */
function abrirRecurso(r) {
  if (r.url) window.open(r.url, "_blank", "noopener");
  else alert("O endereço oficial de “" + r.nome + "” ainda não foi configurado.");
}

function cardFerramenta(r) {
  const col = document.createElement("div");
  col.className = "col-md-6 col-lg-3";
  const card = document.createElement("div");
  card.className = "card resource-card p-3";
  const corpo = document.createElement("div");
  corpo.className = "card-body";

  const icone = document.createElement("div");
  icone.className = "resource-icon"; icone.textContent = r.icone;
  const titulo = document.createElement("h5");
  titulo.className = "mt-3"; titulo.textContent = r.nome;
  const desc = document.createElement("p");
  desc.textContent = r.descricao;
  const botao = document.createElement("button");
  botao.type = "button"; botao.className = "btn btn-outline-primary";
  botao.textContent = "Acessar";
  botao.addEventListener("click", () => abrirRecurso(r));

  corpo.append(icone, titulo, desc, botao);
  card.appendChild(corpo); col.appendChild(card);
  return col;
}

function cardAcademico(r) {
  const col = document.createElement("div");
  col.className = "col-md-4";
  const a = document.createElement("a");
  a.href = "#"; a.className = "card resource-card p-4 text-decoration-none";
  const titulo = document.createElement("h5");
  titulo.textContent = r.icone + " " + r.nome;
  const desc = document.createElement("p");
  desc.className = "text-secondary mb-0"; desc.textContent = r.descricao;
  a.append(titulo, desc);
  a.addEventListener("click", e => { e.preventDefault(); abrirRecurso(r); });
  col.appendChild(a);
  return col;
}

async function carregarFerramentas(q = "") {
  const dados = await json("/recursos?categoria=ferramenta&q=" + encodeURIComponent(q));
  $("listaRecursos").replaceChildren(...dados.map(cardFerramenta));
  $("semResultados").hidden = dados.length !== 0;
}

async function carregarAcademico() {
  const dados = await json("/recursos?categoria=academico");
  $("listaAcademico").replaceChildren(...dados.map(cardAcademico));
}

let temporizador;
$("pesquisa").addEventListener("input", e => {
  clearTimeout(temporizador);
  temporizador = setTimeout(
    () => carregarFerramentas(e.target.value).catch(console.error), 250);
});

/* ---------- Sessão / login ---------- */
const modalLogin = new bootstrap.Modal($("modalLogin"));

function atualizarSessao() {
  const logado = !!sessao;
  $("btnEntrar").hidden = logado;
  $("btnSair").hidden = !logado;
  $("usuarioNome").hidden = !logado;
  $("usuarioNome").textContent = logado ? sessao.usuario.nome : "";
  $("docsDeslogado").hidden = logado;
  $("docsLogado").hidden = !logado;
  if (logado) carregarDocumentos().catch(console.error);
  else $("listaArquivos").replaceChildren();
}

function sair() {
  sessao = null;
  localStorage.removeItem("sessao");
  atualizarSessao();
}

$("btnEntrar").addEventListener("click", () => modalLogin.show());
$("btnSair").addEventListener("click", sair);

$("formLogin").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginErro").hidden = true;
  try {
    sessao = await json("/auth/login", {
      method: "POST",
      body: { email: $("loginEmail").value, senha: $("loginSenha").value }
    });
    localStorage.setItem("sessao", JSON.stringify(sessao));
    $("formLogin").reset();
    modalLogin.hide();
    atualizarSessao();
  } catch (err) {
    $("loginErro").textContent = err.message;
    $("loginErro").hidden = false;
  }
});

/* ---------- Documentos ---------- */
const formatarTamanho = b => (b / 1024).toFixed(1) + " KB";

async function baixar(doc) {
  const resp = await api(`/documentos/${doc.id}/download`);
  const url = URL.createObjectURL(await resp.blob());
  const a = document.createElement("a");
  a.href = url; a.download = doc.nome; a.click();
  URL.revokeObjectURL(url);
}

async function carregarDocumentos() {
  const docs = await json("/documentos");
  $("listaArquivos").replaceChildren(...docs.map(doc => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center gap-2";

    const nome = document.createElement("span");
    nome.className = "text-break"; nome.textContent = doc.nome;
    const tam = document.createElement("small");
    tam.className = "text-muted ms-auto"; tam.textContent = formatarTamanho(doc.tamanho);

    const bBaixar = document.createElement("button");
    bBaixar.className = "btn btn-sm btn-outline-primary"; bBaixar.textContent = "Baixar";
    bBaixar.addEventListener("click", () => baixar(doc).catch(err => alert(err.message)));

    const bExcluir = document.createElement("button");
    bExcluir.className = "btn btn-sm btn-outline-danger"; bExcluir.textContent = "Excluir";
    bExcluir.addEventListener("click", async () => {
      if (!confirm("Excluir “" + doc.nome + "”?")) return;
      try { await api("/documentos/" + doc.id, { method: "DELETE" }); carregarDocumentos(); }
      catch (err) { alert(err.message); }
    });

    li.append(nome, tam, bBaixar, bExcluir);
    return li;
  }));
}

$("btnEnviar").addEventListener("click", async () => {
  const arquivos = $("arquivos").files;
  if (!arquivos.length) return alert("Selecione ao menos um arquivo.");
  const dados = new FormData();
  [...arquivos].forEach(f => dados.append("arquivos", f));
  try {
    await api("/documentos", { method: "POST", body: dados });
    $("arquivos").value = "";
    carregarDocumentos();
  } catch (err) { alert(err.message); }
});

/* ---------- Inicialização ---------- */
carregarFerramentas().catch(console.error);
carregarAcademico().catch(console.error);
atualizarSessao();
