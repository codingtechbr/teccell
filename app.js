/* ===========================================================
   app.js — TechStore PDV
   Lógica principal do sistema. Usa a interface global `DB`
   (definida em firebase.js) para todo acesso a dados.
=========================================================== */

/* ============ ESTADO GLOBAL ============ */
const state = {
  usuario: null,        // usuário logado
  produtos: [],
  clientes: [],
  ordens: [],
  vendas: [],
  config: null,
  caixaSessao: null,     // sessão de caixa aberta (ou null)
  pdv: {
    itens: [],           // {produtoId, nome, qtd, valorUnit}
    cliente: null,
    pagamento: "Dinheiro",
    numeroPedido: null
  }
};

/* ============ HELPERS GERAIS ============ */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function formatMoeda(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
// Converte com segurança qualquer coisa que possa estar em criadoEm/dataEntrega/etc:
// string ISO (formato normal do sistema), objeto Date, ou — para registros antigos que
// ficaram salvos errado — um Timestamp do Firestore (tem método .toDate() ou {seconds,...}).
// Nunca retorna "Invalid Date": se não der pra entender o valor, cai para uma data antiga (1970),
// assim o registro não trava telas nem aparece com "Invalid Date" escrito na tela.
function paraData(valor) {
  if (!valor) return new Date(0);
  if (valor instanceof Date) return isNaN(valor.getTime()) ? new Date(0) : valor;
  if (typeof valor.toDate === 'function') {
    try { return valor.toDate(); } catch (e) { return new Date(0); }
  }
  if (typeof valor === 'object' && typeof valor.seconds === 'number') {
    return new Date(valor.seconds * 1000);
  }
  const d = new Date(valor);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function formatData(iso) {
  if (!iso) return '—';
  const d = paraData(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function formatHora(iso) {
  if (!iso) return '—';
  return paraData(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function apenasData(iso) {
  if (!iso) return '—';
  return paraData(iso).toLocaleDateString('pt-BR');
}
function hojeISO() {
  return new Date().toISOString();
}
function somarDias(iso, dias) {
  const d = paraData(iso);
  d.setDate(d.getDate() + Number(dias || 30));
  return d.toISOString();
}
function uid() {
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
// Remove acentos e caixa para buscas mais tolerantes (ex: "Joao" encontra "João")
function normalizarBusca(str) {
  return (str || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/* Categorias e marcas padrão da loja (aparecem como sugestão ao cadastrar produtos,
   mas o campo continua livre — você pode digitar outra categoria/marca se quiser) */
const CATEGORIAS_PRODUTO = [
  'Aparelho (celular)', 'Tela', 'Bateria', 'Conector de Carga', 'Placa/Circuito',
  'Câmera', 'Alto-falante/Microfone', 'Botão/Flex', 'Capinha/Película',
  'Carregador/Cabo/Fonte', 'Fone de Ouvido', 'Acessório', 'Outro'
];
const MARCAS_PRODUTO = ['iPhone', 'Samsung', 'Motorola', 'Nokia', 'LG', 'Xiaomi', 'Realme'];

/* Monta <optgroup> de produtos agrupados por categoria — usado nos selects de
   peças da OS e de movimentação de estoque, pra facilitar achar o item certo */
function optionsProdutosAgrupados(lista, selecionadoId = null) {
  const grupos = {};
  lista.forEach(p => {
    const cat = (p.categoria || '').trim() || 'Sem categoria';
    (grupos[cat] = grupos[cat] || []).push(p);
  });
  const categorias = Object.keys(grupos).sort((a, b) => {
    if (a === 'Sem categoria') return 1;
    if (b === 'Sem categoria') return -1;
    return a.localeCompare(b, 'pt-BR');
  });
  return categorias.map(cat => `
    <optgroup label="${cat}">
      ${grupos[cat].map(p => `<option value="${p.id}" ${selecionadoId === p.id ? 'selected' : ''}>${p.nome}${p.marca ? ' — ' + p.marca : ''} (${formatMoeda(p.precoVenda)})</option>`).join('')}
    </optgroup>`).join('');
}
// Mesma ideia, mas mostrando a quantidade em estoque (usado nos selects de entrada/saída de estoque)
function optionsProdutosAgrupadosComEstoque(lista) {
  const grupos = {};
  lista.forEach(p => {
    const cat = (p.categoria || '').trim() || 'Sem categoria';
    (grupos[cat] = grupos[cat] || []).push(p);
  });
  const categorias = Object.keys(grupos).sort((a, b) => {
    if (a === 'Sem categoria') return 1;
    if (b === 'Sem categoria') return -1;
    return a.localeCompare(b, 'pt-BR');
  });
  return categorias.map(cat => `
    <optgroup label="${cat}">
      ${grupos[cat].map(p => `<option value="${p.id}">${p.nome} (estoque: ${p.estoque})</option>`).join('')}
    </optgroup>`).join('');
}
function toast(msg, tipo = 'ok') {
  let el = document.getElementById('toast-box');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-box';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(el);
  }
  const item = document.createElement('div');
  const cor = tipo === 'erro' ? '#d9534f' : (tipo === 'aviso' ? '#e8963c' : '#2fa66a');
  item.style.cssText = `background:${cor};color:#fff;padding:12px 18px;border-radius:8px;font-size:13.5px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.2);max-width:320px;`;
  item.textContent = msg;
  el.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

/* Contador sequencial persistente (pedidos / OS) */
async function proximoContador(nomeContador) {
  const cfg = await DB.getById('config', 'contadores') || { id: 'contadores' };
  const atual = (cfg[nomeContador] || 0) + 1;
  await DB.setDocFixo('config', 'contadores', { ...cfg, [nomeContador]: atual });
  return atual;
}

/* ============ MODAL GENÉRICO ============ */
function abrirModal(titulo, htmlCorpo, { grande = false } = {}) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = htmlCorpo;
  $('#modal-box').classList.toggle('modal-lg', grande);
  $('#modal-overlay').classList.remove('hidden');
}
function fecharModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal-corpo').innerHTML = '';
}
$('#modal-fechar').addEventListener('click', fecharModal);
$('#modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') fecharModal(); });

/* ============ IMPRESSÃO ============ */
function imprimirHTML(htmlConteudo) {
  $('#print-area').innerHTML = htmlConteudo;
  window.print();
}
// Lista de itens em formato compacto (nome + "qtd x unit = subtotal"), pensado para bobina de 80mm
function linhasItensRecibo(itens) {
  return `<div class="itens-recibo">${itens.map(i => `
    <div class="item-recibo">
      <div class="item-recibo-nome">${i.nome}</div>
      <div class="item-recibo-linha"><span>${i.qtd} x ${formatMoeda(i.valorUnit)}</span><span>${formatMoeda(i.qtd*i.valorUnit)}</span></div>
    </div>`).join('')}</div>`;
}

/* ===========================================================
   AUTENTICAÇÃO
   - Modo Firebase: login real via Firebase Authentication (e-mail + senha).
     O perfil/permissões do usuário ficam no Firestore, na coleção "usuarios",
     com o ID do documento IGUAL ao UID do Firebase Auth.
   - Modo local (USE_FIREBASE = false): confere usuário/senha direto na
     coleção "usuarios" (sem Firebase Authentication de verdade).
=========================================================== */
let loginEmAndamento = false;

function traduzErroAuth(erro) {
  const mapa = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/user-disabled': 'Este usuário foi desativado.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/too-many-requests': 'Muitas tentativas seguidas. Aguarde um pouco e tente de novo.',
    'auth/email-already-in-use': 'Já existe uma conta com este e-mail.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/network-request-failed': 'Falha de conexão com o Firebase. Verifique sua internet.',
    'auth/operation-not-allowed': 'Login por e-mail/senha não está ativado no Firebase (ative em Authentication > Sign-in method no console do Firebase).'
  };
  return mapa[erro.code] || erro.message || 'Não foi possível concluir. Tente novamente.';
}

// Busca o perfil (nível de acesso etc) do usuário logado no Firestore.
// Se a conta foi criada DIRETO no Firebase Authentication (ex: pelo Firebase
// Console), sem passar pelo cadastro do próprio app, não existe ainda nenhum
// documento em "usuarios" pra esse UID. Nesse caso criamos o perfil na hora,
// automaticamente, com nível padrão "Funcionário" (mais seguro que Admin).
// Um Admin pode depois ajustar o nível em Configurações > Usuários.
async function carregarOuCriarPerfilUsuario(user) {
  let usuario = await DB.getById('usuarios', user.uid);
  if (!usuario) {
    const nomePadrao = (user.email || '').split('@')[0]
      .replace(/[._]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase()) || 'Novo usuário';
    const perfilPadrao = { nome: nomePadrao, usuario: user.email || '', nivel: 'Funcionário', ativo: true };
    await DB.setDocFixo('usuarios', user.uid, perfilPadrao);
    usuario = { id: user.uid, ...perfilPadrao };
    toast('Primeiro acesso detectado — perfil criado automaticamente como Funcionário. Peça a um Admin para ajustar o nível de acesso em Configurações, se precisar.', 'aviso');
  }
  return usuario;
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-usuario').value.trim();
  const senha = $('#login-senha').value;
  const erroEl = $('#login-erro');
  erroEl.textContent = '';
  loginEmAndamento = true;
  try {
    if (USE_FIREBASE) {
      const cred = await firebase.auth().signInWithEmailAndPassword(email, senha);
      const usuario = await carregarOuCriarPerfilUsuario(cred.user);
      if (usuario.ativo === false) {
        erroEl.textContent = 'Este usuário está inativo. Fale com o administrador.';
        await firebase.auth().signOut();
        return;
      }
      state.usuario = usuario;
    } else {
      const usuarios = await DB.getAll('usuarios');
      const usuario = usuarios.find(u => u.usuario === email && u.senha === senha);
      if (!usuario) { erroEl.textContent = 'Usuário ou senha inválidos.'; return; }
      if (usuario.ativo === false) { erroEl.textContent = 'Este usuário está inativo.'; return; }
      state.usuario = usuario;
    }
    await iniciarApp();
  } catch (erro) {
    console.error(erro);
    erroEl.textContent = traduzErroAuth(erro);
  } finally {
    loginEmAndamento = false;
  }
});

// Botão de primeiro acesso: cria a conta admin padrão (uma única vez)
$('#btn-criar-admin')?.addEventListener('click', async () => {
  const erroEl = $('#login-erro');
  erroEl.textContent = '';
  const emailAdmin = 'admin@techstore.local';
  const senhaAdmin = 'admin123';
  loginEmAndamento = true;
  try {
    if (USE_FIREBASE) {
      const cred = await firebase.auth().createUserWithEmailAndPassword(emailAdmin, senhaAdmin);
      const dadosAdmin = { nome: 'Administrador', usuario: emailAdmin, nivel: 'Admin', ativo: true };
      await DB.setDocFixo('usuarios', cred.user.uid, dadosAdmin);
      state.usuario = { id: cred.user.uid, ...dadosAdmin };
      toast('Acesso admin criado!');
      await iniciarApp();
    } else {
      const usuarios = await DB.getAll('usuarios');
      if (usuarios.some(u => u.usuario === 'admin')) {
        erroEl.textContent = 'O usuário admin já existe. Entre com usuário "admin" e senha "admin123".';
        return;
      }
      await DB.add('usuarios', { nome: 'Administrador', usuario: 'admin', senha: 'admin123', nivel: 'Admin', ativo: true });
      toast('Usuário admin criado! Entre com usuário "admin" e senha "admin123".');
    }
  } catch (erro) {
    console.error(erro);
    if (erro.code === 'auth/email-already-in-use') {
      erroEl.textContent = `O acesso admin já existe. Entre com e-mail "${emailAdmin}" e senha "admin123".`;
    } else {
      erroEl.textContent = traduzErroAuth(erro);
    }
  } finally {
    loginEmAndamento = false;
  }
});

// Mantém a sessão "logada" entre recarregamentos de página (não precisa logar toda hora)
if (USE_FIREBASE && typeof firebase !== 'undefined') {
  firebase.auth().onAuthStateChanged(async (user) => {
    if (user && !state.usuario && !loginEmAndamento) {
      try {
        const usuario = await carregarOuCriarPerfilUsuario(user);
        if (usuario.ativo !== false) {
          state.usuario = usuario;
          await iniciarApp();
        }
      } catch (erro) {
        console.error('Falha ao restaurar sessão salva:', erro);
      }
    }
  });
}

async function logout() {
    if (USE_FIREBASE) await firebase.auth().signOut();

    state.usuario = null;

    $('#app').classList.add('hidden');
    $('#tela-login').classList.remove('hidden');

    $('#login-usuario').value = '';
    $('#login-senha').value = '';
}
$('#btn-logout').addEventListener('click', logout);
$('#btn-logout-mobile').addEventListener('click', logout);

/* ===========================================================
   NAVEGAÇÃO
=========================================================== */
const TITULOS_VIEW = {
  dashboard: 'Dashboard', pdv: 'PDV / Vendas', os: 'Ordens de Serviço',
  produtos: 'Produtos / Estoque', clientes: 'Clientes', caixa: 'Caixa',
  relatorios: 'Relatórios', config: 'Configurações'
};

function irParaView(nome) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === nome));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${nome}`));
  $('#topo-titulo-mobile').textContent = TITULOS_VIEW[nome] || '';
  fecharSidebarMobile();
  // Recarrega dados da view ao entrar
  const carregadores = {
    dashboard: renderDashboard, pdv: prepararPDV, os: renderOS,
    produtos: renderProdutos, clientes: renderClientes, caixa: renderCaixa,
    relatorios: () => {}, config: renderConfig
  };
  if (carregadores[nome]) carregadores[nome]();
}
$$('.nav-item').forEach(btn => btn.addEventListener('click', () => irParaView(btn.dataset.view)));

function fecharSidebarMobile() {
  $('#sidebar').classList.remove('open');
  $('#overlay-mobile').classList.remove('show');
}
$('#btn-menu-mobile').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
  $('#overlay-mobile').classList.add('show');
});
$('#overlay-mobile').addEventListener('click', fecharSidebarMobile);

/* ===========================================================
   INICIALIZAÇÃO DO APP
=========================================================== */
async function carregarDadosBase() {
  const [produtos, clientes, ordens, vendas, config, caixaSessoes, usuarios] = await Promise.all([
    DB.getAll('produtos'), DB.getAll('clientes'), DB.getAll('ordens_servico'),
    DB.getAll('vendas'), DB.getById('config', 'loja'), DB.getAll('caixa_sessoes'), DB.getAll('usuarios')
  ]);
  state.produtos = produtos;
  state.clientes = clientes;
  state.ordens = ordens;
  state.vendas = vendas;
  state.config = config || { id: 'loja', nome: 'TechStore', cnpj: '', endereco: '', whatsapp: '', garantiaProduto: 30, garantiaConserto: 30 };
  state.caixaSessao = caixaSessoes.find(c => c.status === 'Aberto') || null;
  state.usuariosCache = usuarios;
}

async function iniciarApp() {
  await carregarDadosBase();
  $('#tela-login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-nome').textContent = state.usuario.nome || state.usuario.usuario;
  $('#user-nivel').textContent = state.usuario.nivel;
  $('#user-avatar').textContent = (state.usuario.nome || state.usuario.usuario).charAt(0).toUpperCase();
  $('#nome-loja-side').textContent = state.config.nome || 'TechStore';
  aplicarPermissoes();
  irParaView('dashboard');
}

function aplicarPermissoes() {
  const nivel = state.usuario.nivel;
  // Técnico não acessa PDV/Caixa/Config; Funcionário não acessa Configurações de usuários
  const restricoesTecnico = ['pdv', 'caixa', 'config'];
  $$('.nav-item').forEach(btn => {
    const view = btn.dataset.view;
    if (nivel === 'Técnico' && restricoesTecnico.includes(view)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
    }
  });
}

/* (a restauração de sessão ao recarregar a página já é feita pelo
   onAuthStateChanged registrado no bloco de AUTENTICAÇÃO, mais acima) */

/* ===========================================================
   DASHBOARD
=========================================================== */
function vendasDoDia() {
  const hoje = new Date().toDateString();
  return state.vendas.filter(v => paraData(v.criadoEm).toDateString() === hoje);
}
function faturamentoEntre(dataIni, dataFim) {
  return state.vendas
    .filter(v => { const d = paraData(v.criadoEm); return d >= dataIni && d <= dataFim; })
    .reduce((s, v) => s + Number(v.total || 0), 0)
    + state.ordens
    .filter(o => o.status === 'Entregue' && o.dataEntrega && paraData(o.dataEntrega) >= dataIni && paraData(o.dataEntrega) <= dataFim)
    .reduce((s, o) => s + Number(o.valorTotal || 0), 0);
}

async function renderDashboard() {
  await carregarDadosBase();
  const vDia = vendasDoDia();
  const totalDia = vDia.reduce((s, v) => s + Number(v.total || 0), 0);

  const osAbertas = state.ordens.filter(o => !['Entregue', 'Cancelada'].includes(o.status));
  const osAndamento = state.ordens.filter(o => ['Em análise', 'Aguardando peça', 'Em manutenção'].includes(o.status));
  const osFinalizadas = state.ordens.filter(o => o.status === 'Entregue');
  const estoqueBaixo = state.produtos.filter(p => Number(p.estoque) <= Number(p.estoqueMinimo || 0));

  const inicioSemana = new Date(); inicioSemana.setDate(inicioSemana.getDate() - 7);
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  const agora = new Date();
  const fatSemana = faturamentoEntre(inicioSemana, agora);
  const fatMes = faturamentoEntre(inicioMes, agora);

  $('#dash-cards').innerHTML = `
    <div class="stat-card accent"><span>Vendas hoje</span><strong>${formatMoeda(totalDia)}</strong><small>${vDia.length} pedido(s)</small></div>
    <div class="stat-card accent-blue"><span>OS abertas</span><strong>${osAbertas.length}</strong><small>aguardando conclusão</small></div>
    <div class="stat-card accent-blue"><span>OS em andamento</span><strong>${osAndamento.length}</strong><small>em análise/manutenção</small></div>
    <div class="stat-card accent-green"><span>OS finalizadas</span><strong>${osFinalizadas.length}</strong><small>entregues ao cliente</small></div>
    <div class="stat-card accent-red"><span>Estoque baixo</span><strong>${estoqueBaixo.length}</strong><small>produtos no limite</small></div>
    <div class="stat-card"><span>Faturamento semanal</span><strong>${formatMoeda(fatSemana)}</strong><small>últimos 7 dias</small></div>
    <div class="stat-card"><span>Faturamento mensal</span><strong>${formatMoeda(fatMes)}</strong><small>mês atual</small></div>
  `;

  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const inicio = new Date(d); inicio.setHours(0,0,0,0);
    const fim = new Date(d); fim.setHours(23,59,59,999);
    dias.push({ label: d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''), valor: faturamentoEntre(inicio, fim) });
  }
  const max = Math.max(...dias.map(d => d.valor), 1);
  $('#dash-grafico').innerHTML = dias.map(d => `
    <div class="barra-col">
      <div class="barra" style="height:${Math.max(4, (d.valor / max) * 130)}px" title="${formatMoeda(d.valor)}"></div>
      <span class="barra-label">${d.label}</span>
    </div>`).join('');

  $('#dash-estoque-baixo').innerHTML = estoqueBaixo.length
    ? estoqueBaixo.slice(0, 8).map(p => `<div class="item-lista"><span>${p.nome}</span><strong>${p.estoque} un.</strong></div>`).join('')
    : `<div class="vazio-msg">Nenhum produto com estoque baixo 🎉</div>`;
}

/* ===========================================================
   PRODUTOS / ESTOQUE
=========================================================== */
function formularioProduto(produto = {}) {
  return `
    <form id="form-produto" class="form-grid">
      <label>Nome do produto*<input type="text" id="p-nome" value="${produto.nome || ''}" required></label>
      <label>Código de barras<input type="text" id="p-codigo" value="${produto.codigoBarras || ''}"></label>
      <label>Categoria<input type="text" id="p-categoria" list="lista-categorias-produto" placeholder="Ex: Tela, Bateria, Conector..." value="${produto.categoria || ''}"></label>
      <label>Marca<input type="text" id="p-marca" list="lista-marcas-produto" placeholder="Ex: iPhone, Samsung..." value="${produto.marca || ''}"></label>
      <datalist id="lista-categorias-produto">${CATEGORIAS_PRODUTO.map(c => `<option value="${c}">`).join('')}</datalist>
      <datalist id="lista-marcas-produto">${MARCAS_PRODUTO.map(m => `<option value="${m}">`).join('')}</datalist>
      <label>Modelo<input type="text" id="p-modelo" value="${produto.modelo || ''}"></label>
      <label>Preço de custo (R$)<input type="number" step="0.01" id="p-custo" value="${produto.precoCusto ?? ''}"></label>
      <label>Preço de venda (R$)*<input type="number" step="0.01" id="p-venda" value="${produto.precoVenda ?? ''}" required></label>
      <label>Quantidade em estoque*<input type="number" id="p-estoque" value="${produto.estoque ?? 0}" required></label>
      <label>Estoque mínimo<input type="number" id="p-estoque-min" value="${produto.estoqueMinimo ?? 2}"></label>
      <label>Garantia padrão (dias)<input type="number" id="p-garantia" value="${produto.garantiaDias ?? 30}"></label>
      <label>Status
        <select id="p-status">
          <option value="ativo" ${produto.status !== 'inativo' ? 'selected' : ''}>Ativo</option>
          <option value="inativo" ${produto.status === 'inativo' ? 'selected' : ''}>Inativo</option>
        </select>
      </label>
      <button type="submit" class="btn btn-primary">${produto.id ? 'Salvar alterações' : 'Cadastrar produto'}</button>
    </form>`;
}

function abrirModalProduto(produtoExistente = null) {
  abrirModal(produtoExistente ? 'Editar produto' : 'Novo produto', formularioProduto(produtoExistente || {}));
  $('#form-produto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = {
      nome: $('#p-nome').value.trim(),
      codigoBarras: $('#p-codigo').value.trim(),
      categoria: $('#p-categoria').value.trim(),
      marca: $('#p-marca').value.trim(),
      modelo: $('#p-modelo').value.trim(),
      precoCusto: parseFloat($('#p-custo').value) || 0,
      precoVenda: parseFloat($('#p-venda').value) || 0,
      estoque: parseInt($('#p-estoque').value) || 0,
      estoqueMinimo: parseInt($('#p-estoque-min').value) || 0,
      garantiaDias: parseInt($('#p-garantia').value) || 30,
      status: $('#p-status').value
    };
    if (produtoExistente) {
      await DB.update('produtos', produtoExistente.id, dados);
      toast('Produto atualizado!');
    } else {
      await DB.add('produtos', dados);
      toast('Produto cadastrado!');
    }
    fecharModal();
    await carregarDadosBase();
    renderProdutos();
  });
}

async function excluirProduto(id) {
  if (!confirm('Excluir este produto? Esta ação não pode ser desfeita.')) return;
  await DB.remove('produtos', id);
  await carregarDadosBase();
  renderProdutos();
  toast('Produto excluído.');
}

function registrarMovimentoEstoque(produtoId, tipo, quantidade, motivo) {
  return DB.add('movimentacoes_estoque', { produtoId, tipo, quantidade, motivo, usuario: state.usuario.usuario });
}

// Devolve ao estoque os produtos de uma venda excluída (itens avulsos sem produtoId são ignorados)
async function estornarEstoqueVenda(venda) {
  for (const item of venda.itens || []) {
    if (!item.produtoId) continue;
    const produto = state.produtos.find(p => p.id === item.produtoId);
    if (!produto) continue;
    await DB.update('produtos', produto.id, { estoque: Number(produto.estoque) + Number(item.qtd) });
    await registrarMovimentoEstoque(produto.id, 'entrada', item.qtd, `Estorno da venda #${venda.numeroPedido} (excluída)`);
  }
}

// Devolve ao estoque as peças de uma OS excluída — só se o estoque já tinha sido baixado
async function estornarEstoquePecasOS(os) {
  if (!os.estoqueBaixado) return;
  for (const peca of os.pecas || []) {
    if (!peca.produtoId) continue;
    const produto = state.produtos.find(p => p.id === peca.produtoId);
    if (!produto) continue;
    await DB.update('produtos', produto.id, { estoque: Number(produto.estoque) + Number(peca.qtd) });
    await registrarMovimentoEstoque(produto.id, 'entrada', peca.qtd, `Estorno da OS #${os.numeroOS} (excluída)`);
  }
}

async function renderProdutos(filtro = '') {
  const filtroNorm = normalizarBusca(filtro);
  const lista = state.produtos.filter(p => !filtro ||
    normalizarBusca(p.nome).includes(filtroNorm) ||
    (p.codigoBarras || '').includes(filtro) ||
    normalizarBusca(p.categoria).includes(filtroNorm) ||
    normalizarBusca(p.marca).includes(filtroNorm)
  );
  $('#produtos-lista-body').innerHTML = lista.length ? lista.map(p => `
    <tr>
      <td><strong>${p.nome}</strong><br><span style="color:var(--texto-sec);font-size:11.5px">${p.marca || ''} ${p.modelo || ''}</span></td>
      <td><span style="font-family:var(--mono)">${p.codigoBarras || '—'}</span></td>
      <td>${p.categoria || '—'}</td>
      <td>${formatMoeda(p.precoCusto)}</td>
      <td>${formatMoeda(p.precoVenda)}</td>
      <td>${p.estoque <= (p.estoqueMinimo||0) ? `<strong style="color:var(--vermelho)">${p.estoque}</strong>` : p.estoque}</td>
      <td><span class="badge ${p.status === 'inativo' ? 'badge-inativo' : 'badge-ativo'}">${p.status === 'inativo' ? 'Inativo' : 'Ativo'}</span></td>
      <td class="acoes-cell">
        <button class="btn btn-sm btn-outline" onclick="abrirModalProduto(${JSON.stringify(p).replace(/"/g, '&quot;')})">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="excluirProduto('${p.id}')">Excluir</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="8"><div class="vazio-msg">Nenhum produto encontrado.</div></td></tr>`;
}

$('#btn-novo-produto').addEventListener('click', () => abrirModalProduto());
$('#produto-busca').addEventListener('input', e => renderProdutos(e.target.value));

$('#btn-entrada-estoque').addEventListener('click', () => {
  abrirModal('Entrada de estoque', `
    <form id="form-mov-estoque" class="form-grid">
      <label class="span2">Produto*
        <select id="mov-produto" required>${optionsProdutosAgrupadosComEstoque(state.produtos)}</select>
      </label>
      <label>Quantidade a adicionar*<input type="number" id="mov-qtd" min="1" value="1" required></label>
      <label>Motivo<input type="text" id="mov-motivo" placeholder="Ex: Compra de fornecedor"></label>
      <button type="submit" class="btn btn-primary">Confirmar entrada</button>
    </form>`);
  $('#form-mov-estoque').addEventListener('submit', async e => {
    e.preventDefault();
    const produto = state.produtos.find(p => p.id === $('#mov-produto').value);
    const qtd = parseInt($('#mov-qtd').value);
    await DB.update('produtos', produto.id, { estoque: Number(produto.estoque) + qtd });
    await registrarMovimentoEstoque(produto.id, 'entrada', qtd, $('#mov-motivo').value || 'Entrada manual');
    fecharModal(); await carregarDadosBase(); renderProdutos();
    toast('Entrada de estoque registrada!');
  });
});

$('#btn-saida-estoque').addEventListener('click', () => {
  abrirModal('Saída manual de estoque', `
    <form id="form-mov-saida" class="form-grid">
      <label class="span2">Produto*
        <select id="mov-produto-s" required>${optionsProdutosAgrupadosComEstoque(state.produtos)}</select>
      </label>
      <label>Quantidade a retirar*<input type="number" id="mov-qtd-s" min="1" value="1" required></label>
      <label>Motivo<input type="text" id="mov-motivo-s" placeholder="Ex: Produto danificado"></label>
      <button type="submit" class="btn btn-primary">Confirmar saída</button>
    </form>`);
  $('#form-mov-saida').addEventListener('submit', async e => {
    e.preventDefault();
    const produto = state.produtos.find(p => p.id === $('#mov-produto-s').value);
    const qtd = parseInt($('#mov-qtd-s').value);
    await DB.update('produtos', produto.id, { estoque: Math.max(0, Number(produto.estoque) - qtd) });
    await registrarMovimentoEstoque(produto.id, 'saida', qtd, $('#mov-motivo-s').value || 'Saída manual');
    fecharModal(); await carregarDadosBase(); renderProdutos();
    toast('Saída de estoque registrada!');
  });
});

$('#btn-hist-estoque').addEventListener('click', async () => {
  const movs = (await DB.getAll('movimentacoes_estoque')).sort((a,b) => paraData(b.criadoEm) - paraData(a.criadoEm));
  const html = movs.length ? `
    <table class="tabela-padrao"><thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th>Qtd</th><th>Motivo</th></tr></thead>
    <tbody>${movs.slice(0,100).map(m => {
      const prod = state.produtos.find(p => p.id === m.produtoId);
      return `<tr><td>${formatData(m.criadoEm)}</td><td>${prod ? prod.nome : '—'}</td><td>${m.tipo === 'entrada' ? '⬆️ Entrada' : '⬇️ Saída'}</td><td>${m.quantidade}</td><td>${m.motivo || '—'}</td></tr>`;
    }).join('')}</tbody></table>` : `<div class="vazio-msg">Nenhuma movimentação registrada.</div>`;
  abrirModal('Histórico de movimentação de estoque', html, { grande: true });
});

/* ===========================================================
   CLIENTES
=========================================================== */
function formularioCliente(cliente = {}) {
  return `
    <form id="form-cliente" class="form-grid">
      <label>Nome*<input type="text" id="c-nome" value="${cliente.nome || ''}" required></label>
      <label>CPF/CNPJ<input type="text" id="c-doc" value="${cliente.documento || ''}"></label>
      <label>Telefone<input type="text" id="c-telefone" value="${cliente.telefone || ''}"></label>
      <label>WhatsApp<input type="text" id="c-whatsapp" value="${cliente.whatsapp || ''}"></label>
      <label class="span2">Endereço (onde mora)<input type="text" id="c-endereco" value="${cliente.endereco || ''}" placeholder="Rua, número, bairro..."></label>
      <label>Cidade<input type="text" id="c-cidade" value="${cliente.cidade || ''}"></label>
      <label class="span2">Observações<textarea id="c-obs">${cliente.observacoes || ''}</textarea></label>
      <button type="submit" class="btn btn-primary">${cliente.id ? 'Salvar alterações' : 'Cadastrar cliente'}</button>
    </form>`;
}

function abrirModalCliente(clienteExistente = null, aoSalvar = null, prefill = null) {
  abrirModal(clienteExistente ? 'Editar cliente' : 'Novo cliente', formularioCliente(clienteExistente || prefill || {}));
  $('#form-cliente').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = {
      nome: $('#c-nome').value.trim(),
      documento: $('#c-doc').value.trim(),
      telefone: $('#c-telefone').value.trim(),
      whatsapp: $('#c-whatsapp').value.trim(),
      endereco: $('#c-endereco').value.trim(),
      cidade: $('#c-cidade').value.trim(),
      observacoes: $('#c-obs').value.trim()
    };
    let salvo;
    if (clienteExistente) {
      salvo = await DB.update('clientes', clienteExistente.id, dados);
      toast('Cliente atualizado!');
    } else {
      salvo = await DB.add('clientes', dados);
      toast('Cliente cadastrado!');
    }
    fecharModal();
    await carregarDadosBase();
    renderClientes();
    if (aoSalvar) aoSalvar(salvo);
  });
}

async function excluirCliente(id) {
  if (!confirm('Excluir este cliente?')) return;
  await DB.remove('clientes', id);
  await carregarDadosBase();
  renderClientes();
  toast('Cliente excluído.');
}

async function verHistoricoCliente(id) {
  const cliente = state.clientes.find(c => c.id === id);
  const comprasCliente = state.vendas.filter(v => v.clienteId === id);
  const osCliente = state.ordens.filter(o => o.clienteId === id);
  const html = `
    <h4 style="margin-top:0">Compras (${comprasCliente.length})</h4>
    ${comprasCliente.length ? `<table class="tabela-padrao"><thead><tr><th>Pedido</th><th>Data</th><th>Hora</th><th>Total</th><th>Pagamento</th><th>Ações</th></tr></thead>
      <tbody>${comprasCliente.map(v => `<tr><td>#${v.numeroPedido}</td><td>${apenasData(v.criadoEm)}</td><td>${formatHora(v.criadoEm)}</td><td>${formatMoeda(v.total)}</td><td>${v.formaPagamento}</td>
        <td class="acoes-cell"><button class="btn btn-sm btn-danger" onclick="excluirVendaHistorico('${v.id}','${id}')">Excluir</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="vazio-msg">Nenhuma compra registrada.</div>'}
    <h4>Ordens de Serviço (${osCliente.length})</h4>
    ${osCliente.length ? `<table class="tabela-padrao"><thead><tr><th>OS</th><th>Data</th><th>Hora</th><th>Aparelho</th><th>Status</th><th>Ações</th></tr></thead>
      <tbody>${osCliente.map(o => `<tr><td>#${o.numeroOS}</td><td>${apenasData(o.criadoEm)}</td><td>${formatHora(o.criadoEm)}</td><td>${o.aparelho}</td><td>${badgeStatusOS(o.status)}</td>
        <td class="acoes-cell"><button class="btn btn-sm btn-danger" onclick="excluirOSHistorico('${o.id}','${id}')">Excluir</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="vazio-msg">Nenhuma OS registrada.</div>'}
  `;
  abrirModal(`Histórico de ${cliente ? cliente.nome : ''}`, html, { grande: true });
}

async function excluirVendaHistorico(vendaId, clienteId) {
  if (!confirm('Excluir esta venda do histórico? O estoque dos produtos vendidos será devolvido automaticamente.')) return;
  const venda = state.vendas.find(v => v.id === vendaId);
  if (venda) await estornarEstoqueVenda(venda);
  await DB.remove('vendas', vendaId);
  await carregarDadosBase();
  toast('Venda excluída e estoque devolvido.');
  verHistoricoCliente(clienteId);
}

async function excluirOSHistorico(osId, clienteId) {
  if (!confirm('Excluir esta Ordem de Serviço do histórico? O estoque das peças utilizadas será devolvido automaticamente (se já tinha sido baixado).')) return;
  const os = state.ordens.find(o => o.id === osId);
  if (os) await estornarEstoquePecasOS(os);
  await DB.remove('ordens_servico', osId);
  await carregarDadosBase();
  toast('OS excluída e estoque devolvido.');
  verHistoricoCliente(clienteId);
}

async function renderClientes(filtro = '') {
  const lista = state.clientes.filter(c => !filtro ||
    (c.nome || '').toLowerCase().includes(filtro.toLowerCase()) ||
    (c.documento || '').includes(filtro) ||
    (c.telefone || '').includes(filtro)
  );
  $('#clientes-lista-body').innerHTML = lista.length ? lista.map(c => `
    <tr>
      <td><strong>${c.nome}</strong></td>
      <td>${c.documento || '—'}</td>
      <td>${c.telefone || '—'}</td>
      <td>${c.whatsapp || '—'}</td>
      <td>${c.cidade || '—'}</td>
      <td class="acoes-cell">
        <button class="btn btn-sm btn-outline" onclick="verHistoricoCliente('${c.id}')">Histórico</button>
        <button class="btn btn-sm btn-outline" onclick='abrirModalClienteEdicao("${c.id}")'>Editar</button>
        <button class="btn btn-sm btn-danger" onclick="excluirCliente('${c.id}')">Excluir</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="vazio-msg">Nenhum cliente encontrado.</div></td></tr>`;
}
function abrirModalClienteEdicao(id) {
  const cliente = state.clientes.find(c => c.id === id);
  abrirModalCliente(cliente);
}

$('#btn-novo-cliente').addEventListener('click', () => abrirModalCliente());
$('#cliente-busca').addEventListener('input', e => renderClientes(e.target.value));

/* ===========================================================
   PDV / VENDAS
=========================================================== */
async function prepararPDV() {
  if (!state.pdv.numeroPedido) {
    const cfg = await DB.getById('config', 'contadores') || { pedido: 0 };
    state.pdv.numeroPedido = '#' + ((cfg.pedido || 0) + 1) + ' (previsto)';
  }
  $('#pdv-data').textContent = new Date().toLocaleDateString('pt-BR');
  $('#pdv-operador').textContent = state.usuario.nome || state.usuario.usuario;
  $('#pdv-numero-pedido').textContent = state.pdv.numeroPedido;
  renderPDVCliente();
  renderPDVItens();
}

function renderPDVCliente() {
  const el = $('#pdv-cliente-selecionado');
  el.innerHTML = state.pdv.cliente
    ? `✓ ${state.pdv.cliente.nome} ${state.pdv.cliente.documento ? '· ' + state.pdv.cliente.documento : ''} <button class="btn btn-sm btn-outline" style="margin-left:8px" onclick="limparClientePDV()">Trocar</button>`
    : `<span style="color:var(--texto-sec)">Venda balcão (sem cliente identificado) — opcional</span>`;
}
function limparClientePDV() { state.pdv.cliente = null; renderPDVCliente(); }

$('#pdv-cliente-busca').addEventListener('input', (e) => {
  const termo = e.target.value.trim();
  const box = $('#pdv-sugestoes');
  if (!termo) { box.classList.add('hidden'); box.innerHTML=''; return; }
  const termoNorm = normalizarBusca(termo);
  const achados = state.clientes.filter(c =>
    normalizarBusca(c.nome).includes(termoNorm) ||
    (c.documento||'').includes(termo) ||
    (c.telefone||'').includes(termo) ||
    (c.whatsapp||'').includes(termo)
  ).slice(0, 6);
  if (!achados.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = achados.map(c => `<div class="sugestao-item" data-cli="${c.id}"><span>${c.nome}</span><span style="color:var(--texto-sec)">${c.telefone||c.documento||''}${c.cidade ? ' · '+c.cidade : ''}</span></div>`).join('');
  box.querySelectorAll('.sugestao-item').forEach(it => it.addEventListener('click', () => {
    state.pdv.cliente = state.clientes.find(c => c.id === it.dataset.cli);
    renderPDVCliente();
    $('#pdv-cliente-busca').value = ''; box.classList.add('hidden'); box.innerHTML = '';
  }));
});

$('#btn-pdv-cadastrar-cliente').addEventListener('click', () => {
  abrirModalCliente(null, (novoCliente) => { state.pdv.cliente = novoCliente; renderPDVCliente(); });
});
$('#btn-pdv-cadastrar-produto').addEventListener('click', () => abrirModalProduto());

function addItemPDV(produto, qtd = 1) {
  const existente = state.pdv.itens.find(i => i.produtoId === produto.id);
  if (existente) existente.qtd += qtd;
  else state.pdv.itens.push({ produtoId: produto.id, nome: produto.nome, qtd, valorUnit: Number(produto.precoVenda) });
  renderPDVItens();
}

$('#pdv-busca-produto').addEventListener('input', (e) => {
  const termo = e.target.value.trim().toLowerCase();
  const box = $('#pdv-sugestoes');
  if (!termo) { box.classList.add('hidden'); box.innerHTML=''; return; }
  const achados = state.produtos.filter(p => p.status !== 'inativo' && (p.nome.toLowerCase().includes(termo) || (p.codigoBarras||'').includes(termo))).slice(0, 8);
  box.classList.toggle('hidden', achados.length === 0);
  box.innerHTML = achados.map(p => `<div class="sugestao-item" data-prod="${p.id}"><span>${p.nome} <span style="color:var(--texto-sec);font-size:12px">(${p.estoque} em estoque)</span></span><strong>${formatMoeda(p.precoVenda)}</strong></div>`).join('');
  box.querySelectorAll('.sugestao-item').forEach(it => it.addEventListener('click', () => {
    const produto = state.produtos.find(p => p.id === it.dataset.prod);
    addItemPDV(produto);
    $('#pdv-busca-produto').value = ''; box.classList.add('hidden'); box.innerHTML = '';
  }));
});
$('#pdv-busca-produto').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const termo = e.target.value.trim().toLowerCase();
  if (!termo) return;
  const produto = state.produtos.find(p => (p.codigoBarras || '').toLowerCase() === termo) ||
                  state.produtos.find(p => p.nome.toLowerCase().includes(termo));
  if (produto) { addItemPDV(produto); e.target.value = ''; $('#pdv-sugestoes').classList.add('hidden'); }
  else toast('Produto não encontrado.', 'erro');
});

function renderPDVItens() {
  const itens = state.pdv.itens;
  $('#pdv-vazio').classList.toggle('hidden', itens.length > 0);
  $('#pdv-itens-body').innerHTML = itens.map((it, idx) => `
    <tr>
      <td>${it.nome}</td>
      <td><input type="number" min="1" value="${it.qtd}" onchange="alterarQtdPDV(${idx}, this.value)"></td>
      <td>${formatMoeda(it.valorUnit)}</td>
      <td>${formatMoeda(it.qtd * it.valorUnit)}</td>
      <td><button class="btn btn-sm btn-danger" onclick="removerItemPDV(${idx})">✕</button></td>
    </tr>`).join('');
  const total = itens.reduce((s, i) => s + i.qtd * i.valorUnit, 0);
  $('#pdv-total').textContent = formatMoeda(total);
}
function alterarQtdPDV(idx, val) { state.pdv.itens[idx].qtd = Math.max(1, parseInt(val) || 1); renderPDVItens(); }
function removerItemPDV(idx) { state.pdv.itens.splice(idx, 1); renderPDVItens(); }

$('#btn-pdv-item-avulso').addEventListener('click', () => {
  abrirModal('Adicionar item avulso', `
    <form id="form-item-avulso" class="form-grid">
      <label class="span2">Descrição*<input type="text" id="av-nome" required></label>
      <label>Quantidade*<input type="number" id="av-qtd" min="1" value="1" required></label>
      <label>Valor unitário (R$)*<input type="number" step="0.01" id="av-valor" required></label>
      <button type="submit" class="btn btn-primary">Adicionar à venda</button>
    </form>`);
  $('#form-item-avulso').addEventListener('submit', (e) => {
    e.preventDefault();
    state.pdv.itens.push({ produtoId: null, nome: $('#av-nome').value.trim(), qtd: parseInt($('#av-qtd').value), valorUnit: parseFloat($('#av-valor').value) });
    renderPDVItens(); fecharModal();
  });
});

$('#btn-pdv-lista-produtos').addEventListener('click', () => {
  const ativos = state.produtos.filter(p => p.status !== 'inativo');
  abrirModal('Lista de produtos', `
    <input type="text" id="lp-busca" placeholder="Filtrar..." style="width:100%;padding:10px;border:1px solid var(--borda);border-radius:8px;margin-bottom:12px;">
    <div id="lp-lista" class="tabela-wrap" style="max-height:400px;overflow:auto;">
      <table class="tabela-padrao"><thead><tr><th>Produto</th><th>Preço</th><th>Estoque</th><th></th></tr></thead>
      <tbody>${ativos.map(p => `<tr data-nome="${p.nome.toLowerCase()}">
        <td>${p.nome}</td><td>${formatMoeda(p.precoVenda)}</td><td>${p.estoque}</td>
        <td><button class="btn btn-sm btn-primary" onclick='addItemPDV(${JSON.stringify(p).replace(/"/g,'&quot;')});fecharModal();'>Adicionar</button></td>
      </tr>`).join('')}</tbody></table>
    </div>`, { grande: true });
  $('#lp-busca').addEventListener('input', (e) => {
    const t = e.target.value.toLowerCase();
    $$('#lp-lista tbody tr').forEach(tr => tr.style.display = tr.dataset.nome.includes(t) ? '' : 'none');
  });
});

$$('.pagto-btn').forEach(btn => btn.addEventListener('click', () => {
  $$('.pagto-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.pdv.pagamento = btn.dataset.pagto;
}));

$('#btn-pdv-ver-caixa').addEventListener('click', () => irParaView('caixa'));

/* ---- Histórico de vendas (listar e apagar vendas do PDV) ---- */
function linhaVendaHistoricoGeral(v) {
  return `<tr>
    <td><span style="font-family:var(--mono)">#${v.numeroPedido}</span></td>
    <td>${apenasData(v.criadoEm)}<br><span style="font-size:11px;color:var(--texto-sec)">${formatHora(v.criadoEm)}</span></td>
    <td>${v.clienteNome || 'Balcão (sem cliente)'}</td>
    <td>${(v.itens||[]).map(i=>i.nome).join(', ')}</td>
    <td>${formatMoeda(v.total)}</td>
    <td>${v.formaPagamento||'—'}</td>
    <td class="acoes-cell"><button class="btn btn-sm btn-danger" onclick="excluirVendaGeral('${v.id}')">Excluir</button></td>
  </tr>`;
}
function abrirHistoricoVendas() {
  const vendas = [...state.vendas].sort((a,b) => paraData(b.criadoEm) - paraData(a.criadoEm));
  const html = vendas.length ? `
    <input type="text" id="hv-busca" placeholder="Filtrar por cliente ou nº do pedido..." style="width:100%;padding:10px;border:1px solid var(--borda);border-radius:8px;margin-bottom:12px;">
    <div class="tabela-wrap" style="max-height:440px;overflow:auto;">
      <table class="tabela-padrao"><thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Produto(s)</th><th>Total</th><th>Pagamento</th><th>Ações</th></tr></thead>
      <tbody id="hv-lista-body">${vendas.map(linhaVendaHistoricoGeral).join('')}</tbody></table>
    </div>` : `<div class="vazio-msg">Nenhuma venda registrada ainda.</div>`;
  abrirModal('Histórico de vendas', html, { grande: true });
  const buscaEl = $('#hv-busca');
  if (buscaEl) {
    buscaEl.addEventListener('input', (e) => {
      const termo = e.target.value.trim();
      const termoNorm = normalizarBusca(termo);
      const filtradas = vendas.filter(v => normalizarBusca(v.clienteNome).includes(termoNorm) || String(v.numeroPedido).includes(termo));
      $('#hv-lista-body').innerHTML = filtradas.length ? filtradas.map(linhaVendaHistoricoGeral).join('') : `<tr><td colspan="7"><div class="vazio-msg">Nenhuma venda encontrada.</div></td></tr>`;
    });
  }
}
async function excluirVendaGeral(id) {
  if (!confirm('Excluir esta venda? O estoque dos produtos vendidos será devolvido automaticamente.')) return;
  const venda = state.vendas.find(v => v.id === id);
  if (venda) await estornarEstoqueVenda(venda);
  await DB.remove('vendas', id);
  await carregarDadosBase();
  toast('Venda excluída e estoque devolvido.');
  abrirHistoricoVendas();
}
$('#btn-pdv-hist-vendas').addEventListener('click', () => abrirHistoricoVendas());

$('#btn-pdv-fechar').addEventListener('click', () => {
  if (state.pdv.itens.length && !confirm('Há itens na venda atual. Deseja realmente limpar o PDV?')) return;
  state.pdv.itens = []; state.pdv.cliente = null; state.pdv.pagamento = 'Dinheiro';
  $$('.pagto-btn').forEach(b => b.classList.toggle('active', b.dataset.pagto === 'Dinheiro'));
  renderPDVItens(); renderPDVCliente();
  toast('PDV limpo.');
});

$('#btn-pdv-orcamento').addEventListener('click', () => {
  if (!state.pdv.itens.length) return toast('Adicione itens para gerar o orçamento.', 'erro');
  const total = state.pdv.itens.reduce((s, i) => s + i.qtd * i.valorUnit, 0);
  imprimirHTML(`
    <div class="doc-imp">
      <h1>ORÇAMENTO — ${state.config.nome}</h1>
      <div class="linha-info"><span>Data</span><span>${new Date().toLocaleDateString('pt-BR')}</span></div>
      <div class="linha-info"><span>Hora</span><span>${formatHora(hojeISO())}</span></div>
      <div class="linha-info"><span>Cliente</span><span>${state.pdv.cliente ? state.pdv.cliente.nome : 'Não identificado'}</span></div>
      ${linhasItensRecibo(state.pdv.itens)}
      <h2 style="text-align:right">Total: ${formatMoeda(total)}</h2>
      <p style="font-size:11px;color:#666">Orçamento sem validade fiscal. Sujeito a alteração de preço e disponibilidade de estoque.</p>
    </div>`);
});

$('#btn-pdv-finalizar').addEventListener('click', async () => {
  if (!state.pdv.itens.length) return toast('Adicione ao menos um item à venda.', 'erro');
  if (!state.caixaSessao) {
    toast('Abra o caixa antes de finalizar vendas.', 'erro');
    return irParaView('caixa');
  }
  const total = state.pdv.itens.reduce((s, i) => s + i.qtd * i.valorUnit, 0);
  const numeroPedido = await proximoContador('pedido');

  // baixa de estoque
  for (const item of state.pdv.itens) {
    if (item.produtoId) {
      const produto = state.produtos.find(p => p.id === item.produtoId);
      if (produto) {
        await DB.update('produtos', produto.id, { estoque: Math.max(0, Number(produto.estoque) - item.qtd) });
        await registrarMovimentoEstoque(produto.id, 'saida', item.qtd, `Venda #${numeroPedido}`);
      }
    }
  }

  const venda = await DB.add('vendas', {
    numeroPedido,
    clienteId: state.pdv.cliente ? state.pdv.cliente.id : null,
    clienteNome: state.pdv.cliente ? state.pdv.cliente.nome : 'Consumidor não identificado',
    itens: state.pdv.itens,
    total,
    formaPagamento: state.pdv.pagamento,
    operador: state.usuario.usuario,
    garantiaDias: state.config.garantiaProduto || 30
  });

  await DB.add('caixa_movimentos', {
    sessaoId: state.caixaSessao.id, tipo: 'venda', descricao: `Venda #${numeroPedido}`,
    formaPagamento: state.pdv.pagamento, valor: total
  });

  toast(`Venda #${numeroPedido} finalizada com sucesso!`);
  imprimirReciboVenda(venda);

  state.pdv.itens = []; state.pdv.cliente = null; state.pdv.numeroPedido = null;
  await carregarDadosBase();
  await prepararPDV();
});

function imprimirReciboVenda(venda) {
  const dataFinal = somarDias(venda.criadoEm || hojeISO(), venda.garantiaDias);
  imprimirHTML(`
    <div class="doc-imp">
      <h1>RECIBO DE VENDA — Pedido #${venda.numeroPedido}</h1>
      <div class="linha-info"><span>Loja</span><span>${state.config.nome}${state.config.cnpj ? ' · CNPJ ' + state.config.cnpj : ''}</span></div>
      <div class="linha-info"><span>Endereço</span><span>${state.config.endereco || '—'}</span></div>
      <div class="linha-info"><span>Contato</span><span>${state.config.whatsapp || '—'}</span></div>
      <div class="linha-info"><span>Data</span><span>${apenasData(venda.criadoEm || hojeISO())}</span></div>
      <div class="linha-info"><span>Hora</span><span>${formatHora(venda.criadoEm || hojeISO())}</span></div>
      <div class="linha-info"><span>Cliente</span><span>${venda.clienteNome}</span></div>
      ${linhasItensRecibo(venda.itens)}
      <h2 style="text-align:right">Total: ${formatMoeda(venda.total)} — ${venda.formaPagamento}</h2>
      <p style="font-size:11px;color:#666">Garantia do(s) produto(s) até ${apenasData(dataFinal)} (${venda.garantiaDias} dias), conforme termo de garantia.</p>
    </div>`);
  setTimeout(() => imprimirTermoGarantiaProduto(venda), 400);
}

function imprimirTermoGarantiaProduto(venda) {
  const dataFinal = somarDias(venda.criadoEm || hojeISO(), venda.garantiaDias);
  const cliente = state.clientes.find(c => c.id === venda.clienteId);
  const texto = `A loja concede ao cliente garantia de ${venda.garantiaDias} dias a partir da data da compra, referente ao produto adquirido nesta venda.

A garantia cobre exclusivamente defeitos de fabricação ou funcionamento apresentados em condições normais de uso.

A garantia não cobre:
- Mau uso;
- Quedas;
- Quebra de tela ou carcaça;
- Contato com água ou umidade;
- Oxidação;
- Produto violado ou aberto por terceiros;
- Danos causados por carregadores, cabos ou acessórios inadequados;
- Arranhões, marcas de uso ou danos físicos;
- Perda de embalagem, lacres ou acessórios, quando aplicável.

Para acionar a garantia, o cliente deverá apresentar este termo, o recibo de compra e o produto em bom estado de conservação.

Após análise técnica, caso seja constatado defeito coberto pela garantia, a loja poderá realizar troca, reparo ou outra solução adequada conforme disponibilidade.

Declaro estar ciente das condições acima.`;
  imprimirHTML(`
    <div class="doc-imp">
      <h1>TERMO DE GARANTIA DE PRODUTO</h1>
      <div class="linha-info"><span>Loja</span><span>${state.config.nome}${state.config.cnpj ? ' · CNPJ ' + state.config.cnpj : ''}</span></div>
      <div class="linha-info"><span>Endereço</span><span>${state.config.endereco || '—'}</span></div>
      <div class="linha-info"><span>Telefone/WhatsApp</span><span>${state.config.whatsapp || '—'}</span></div>
      <div class="linha-info"><span>Cliente</span><span>${venda.clienteNome}</span></div>
      <div class="linha-info"><span>CPF do cliente</span><span>${cliente ? cliente.documento || '—' : '—'}</span></div>
      <div class="linha-info"><span>Produto(s)</span><span>${venda.itens.map(i=>i.nome).join(', ')}</span></div>
      <div class="linha-info"><span>Valor</span><span>${formatMoeda(venda.total)}</span></div>
      <div class="linha-info"><span>Data da compra</span><span>${apenasData(venda.criadoEm || hojeISO())}</span></div>
      <div class="linha-info"><span>Garantia até</span><span>${apenasData(dataFinal)}</span></div>
      <div class="linha-info"><span>Número do pedido</span><span>#${venda.numeroPedido}</span></div>
      <p class="clausulas">${texto}</p>
      <div class="assinaturas">
        <div class="assinatura-box">Assinatura do cliente</div>
        <div class="assinatura-box">Assinatura da loja</div>
      </div>
    </div>`);
}

/* ===========================================================
   ORDENS DE SERVIÇO
=========================================================== */
const STATUS_OS = ['Aberta', 'Em análise', 'Aguardando peça', 'Em manutenção', 'Pronto', 'Entregue', 'Cancelada'];
function badgeStatusOS(status) {
  const map = { 'Aberta':'badge-aberta','Em análise':'badge-analise','Aguardando peça':'badge-peca','Em manutenção':'badge-manutencao','Pronto':'badge-pronto','Entregue':'badge-entregue','Cancelada':'badge-cancelada' };
  return `<span class="badge ${map[status]||''}">${status}</span>`;
}

let osPecasTemp = []; // peças sendo adicionadas no formulário de OS aberto no modal

function formularioOS(os = {}) {
  osPecasTemp = os.pecas ? [...os.pecas] : [];
  const tecnicos = (state.usuariosCache || []).filter(u => u.nivel === 'Técnico');
  const clienteJaSelecionado = os.clienteId ? state.clientes.find(c => c.id === os.clienteId) : null;
  return `
    <form id="form-os" class="form-grid">
      <label class="span2">Cliente*
        <div style="position:relative">
          <div style="display:flex;gap:8px">
            <input type="text" id="os-cliente-busca" autocomplete="off" placeholder="Digite o nome ou telefone do cliente..." style="flex:1">
            <button type="button" class="btn btn-sm btn-ghost" id="os-novo-cliente">+ Cliente</button>
          </div>
          <div id="os-cliente-sugestoes" class="pdv-sugestoes hidden" style="position:absolute;z-index:30;width:100%"></div>
        </div>
        <input type="hidden" id="os-cliente" value="${os.clienteId || ''}">
        <div id="os-cliente-selecionado" style="margin-top:6px;font-size:13px;font-weight:600;color:var(--verde)">${clienteJaSelecionado ? `✓ ${clienteJaSelecionado.nome}${clienteJaSelecionado.telefone ? ' · ' + clienteJaSelecionado.telefone : ''}${clienteJaSelecionado.cidade ? ' · ' + clienteJaSelecionado.cidade : ''}` : (os.clienteNome ? `✓ ${os.clienteNome}` : '')}</div>
      </label>
      <label>Telefone do cliente<input type="text" id="os-telefone" value="${os.telefoneCliente||''}"></label>
      <label>Técnico responsável<input type="text" id="os-tecnico" value="${os.tecnicoResponsavel||''}" placeholder="Nome do técnico"></label>
      <label>Aparelho*<input type="text" id="os-aparelho" value="${os.aparelho||''}" required placeholder="Ex: Smartphone"></label>
      <label>Marca<input type="text" id="os-marca" value="${os.marca||''}"></label>
      <label>Modelo<input type="text" id="os-modelo" value="${os.modelo||''}"></label>
      <label>IMEI<input type="text" id="os-imei" value="${os.imei||''}"></label>
      <label>Senha do aparelho<input type="text" id="os-senha" value="${os.senhaAparelho||''}" placeholder="Se informado pelo cliente"></label>
      <label class="span2">Estado físico do aparelho<textarea id="os-estado">${os.estadoFisico||''}</textarea></label>
      <label class="span2">Defeito relatado pelo cliente*<textarea id="os-defeito" required>${os.defeitoRelatado||''}</textarea></label>
      <label class="span2">Diagnóstico técnico<textarea id="os-diagnostico">${os.diagnosticoTecnico||''}</textarea></label>
      <label class="span2">Serviço a realizar<textarea id="os-servico">${os.servicoRealizar||''}</textarea></label>

      <label class="span2">Peças utilizadas
        <div style="display:flex;gap:8px;margin-top:4px">
          <select id="os-peca-select" style="flex:1"><option value="">Selecionar produto do estoque...</option>${optionsProdutosAgrupados(state.produtos.filter(p => p.status !== 'inativo'))}</select>
          <button type="button" class="btn btn-sm btn-outline" id="os-add-peca">Adicionar</button>
        </div>
        <div id="os-pecas-lista" style="margin-top:8px"></div>
      </label>

      <label>Valor das peças (R$)<input type="number" step="0.01" id="os-valor-pecas" value="${os.valorPecas||0}" readonly></label>
      <label>Valor da mão de obra (R$)<input type="number" step="0.01" id="os-valor-mo" value="${os.valorMaoObra||0}"></label>
      <label>Status
        <select id="os-status">${STATUS_OS.map(s=>`<option ${os.status===s?'selected':''}>${s}</option>`).join('')}</select>
      </label>
      <label>Garantia do conserto (dias)<input type="number" id="os-garantia" value="${os.garantiaDias ?? state.config.garantiaConserto ?? 30}"></label>
      <label class="span2">Observações internas<textarea id="os-obs">${os.observacoesInternas||''}</textarea></label>
      <button type="submit" class="btn btn-primary">${os.id ? 'Salvar alterações' : 'Criar Ordem de Serviço'}</button>
    </form>`;
}

function renderPecasOSForm() {
  const totalPecas = osPecasTemp.reduce((s,p) => s + p.qtd * p.valor, 0);
  $('#os-pecas-lista').innerHTML = osPecasTemp.length ? osPecasTemp.map((p,idx) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed var(--borda);font-size:13px">
      <span>${p.nome} x${p.qtd}</span><span>${formatMoeda(p.qtd*p.valor)} <button type="button" class="btn btn-sm btn-danger" onclick="removerPecaOS(${idx})" style="margin-left:6px">✕</button></span>
    </div>`).join('') : `<span style="color:var(--texto-sec);font-size:12.5px">Nenhuma peça adicionada.</span>`;
  const campoValor = $('#os-valor-pecas');
  if (campoValor) campoValor.value = totalPecas.toFixed(2);
}
function removerPecaOS(idx) { osPecasTemp.splice(idx, 1); renderPecasOSForm(); }

function abrirModalOS(osExistente = null) {
  abrirModal(osExistente && osExistente.id ? `Editar OS #${osExistente.numeroOS}` : 'Nova Ordem de Serviço', formularioOS(osExistente || {}), { grande: true });
  renderPecasOSForm();

  // Busca de cliente com sugestões de nomes parecidos (evita cadastrar duplicado)
  function selecionarClienteOS(cliente) {
    $('#os-cliente').value = cliente.id;
    $('#os-cliente-selecionado').innerHTML = `✓ ${cliente.nome}${cliente.telefone ? ' · ' + cliente.telefone : ''}${cliente.cidade ? ' · ' + cliente.cidade : ''}`;
    if (!$('#os-telefone').value.trim() && (cliente.telefone || cliente.whatsapp)) {
      $('#os-telefone').value = cliente.telefone || cliente.whatsapp;
    }
    $('#os-cliente-busca').value = '';
    $('#os-cliente-sugestoes').classList.add('hidden');
    $('#os-cliente-sugestoes').innerHTML = '';
  }
  $('#os-cliente-busca').addEventListener('input', (e) => {
    const termo = e.target.value.trim();
    const box = $('#os-cliente-sugestoes');
    if (!termo) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const termoNorm = normalizarBusca(termo);
    const achados = state.clientes.filter(c =>
      normalizarBusca(c.nome).includes(termoNorm) ||
      (c.telefone || '').includes(termo) ||
      (c.whatsapp || '').includes(termo) ||
      (c.documento || '').includes(termo)
    ).slice(0, 6);
    if (!achados.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = achados.map(c => `
      <div class="sugestao-item" data-cli="${c.id}">
        <span>${c.nome}</span>
        <span style="color:var(--texto-sec)">${c.telefone || c.whatsapp || ''}${c.cidade ? ' · ' + c.cidade : ''}</span>
      </div>`).join('');
    box.querySelectorAll('.sugestao-item').forEach(it => it.addEventListener('click', () => {
      const cliente = state.clientes.find(c => c.id === it.dataset.cli);
      if (cliente) selecionarClienteOS(cliente);
    }));
  });

  $('#os-novo-cliente').addEventListener('click', () => {
    // guarda o que já foi preenchido na OS antes de abrir o cadastro de cliente
    const rascunho = {
      id: osExistente ? osExistente.id : undefined,
      numeroOS: osExistente ? osExistente.numeroOS : undefined,
      criadoEm: osExistente ? osExistente.criadoEm : undefined,
      telefoneCliente: $('#os-telefone').value.trim(),
      tecnicoResponsavel: $('#os-tecnico').value.trim(),
      aparelho: $('#os-aparelho').value.trim(),
      marca: $('#os-marca').value.trim(),
      modelo: $('#os-modelo').value.trim(),
      imei: $('#os-imei').value.trim(),
      senhaAparelho: $('#os-senha').value.trim(),
      estadoFisico: $('#os-estado').value.trim(),
      defeitoRelatado: $('#os-defeito').value.trim(),
      diagnosticoTecnico: $('#os-diagnostico').value.trim(),
      servicoRealizar: $('#os-servico').value.trim(),
      valorMaoObra: $('#os-valor-mo').value,
      status: $('#os-status').value,
      garantiaDias: $('#os-garantia').value,
      observacoesInternas: $('#os-obs').value.trim(),
      pecas: [...osPecasTemp]
    };
    const nomeDigitado = $('#os-cliente-busca').value.trim();
    abrirModalCliente(null, (novoCliente) => {
      rascunho.clienteId = novoCliente.id;
      if (!rascunho.telefoneCliente) rascunho.telefoneCliente = novoCliente.telefone || '';
      abrirModalOS(rascunho);
    }, nomeDigitado ? { nome: nomeDigitado } : null);
  });

  $('#os-add-peca').addEventListener('click', () => {
    const sel = $('#os-peca-select');
    const produto = state.produtos.find(p => p.id === sel.value);
    if (!produto) return;
    const existente = osPecasTemp.find(p => p.produtoId === produto.id);
    if (existente) existente.qtd += 1;
    else osPecasTemp.push({ produtoId: produto.id, nome: produto.nome, qtd: 1, valor: Number(produto.precoVenda) });
    renderPecasOSForm();
  });

  $('#form-os').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#os-cliente').value) {
      toast('Selecione um cliente para a OS (digite o nome e escolha na lista, ou clique em "+ Cliente").', 'erro');
      return;
    }
    const valorPecas = osPecasTemp.reduce((s,p) => s + p.qtd * p.valor, 0);
    const valorMO = parseFloat($('#os-valor-mo').value) || 0;
    const clienteSel = state.clientes.find(c => c.id === $('#os-cliente').value);
    const statusNovo = $('#os-status').value;

    const dados = {
      clienteId: clienteSel ? clienteSel.id : null,
      clienteNome: clienteSel ? clienteSel.nome : '',
      telefoneCliente: $('#os-telefone').value.trim(),
      tecnicoResponsavel: $('#os-tecnico').value.trim(),
      aparelho: $('#os-aparelho').value.trim(),
      marca: $('#os-marca').value.trim(),
      modelo: $('#os-modelo').value.trim(),
      imei: $('#os-imei').value.trim(),
      senhaAparelho: $('#os-senha').value.trim(),
      estadoFisico: $('#os-estado').value.trim(),
      defeitoRelatado: $('#os-defeito').value.trim(),
      diagnosticoTecnico: $('#os-diagnostico').value.trim(),
      servicoRealizar: $('#os-servico').value.trim(),
      pecas: osPecasTemp,
      valorPecas,
      valorMaoObra: valorMO,
      valorTotal: valorPecas + valorMO,
      status: statusNovo,
      garantiaDias: parseInt($('#os-garantia').value) || 30,
      observacoesInternas: $('#os-obs').value.trim()
    };
    const osEmEdicao = osExistente && osExistente.id;
    if (statusNovo === 'Entregue' && (!osEmEdicao || osExistente.status !== 'Entregue')) {
      dados.dataEntrega = hojeISO();
    }

    let salvo;
    if (osEmEdicao) {
      // baixa de estoque somente das peças novas (comparação simples: se ainda não baixou)
      if (!osExistente.estoqueBaixado && statusNovo !== 'Aberta') {
        for (const peca of osPecasTemp) {
          const produto = state.produtos.find(p => p.id === peca.produtoId);
          if (produto) {
            await DB.update('produtos', produto.id, { estoque: Math.max(0, Number(produto.estoque) - peca.qtd) });
            await registrarMovimentoEstoque(produto.id, 'saida', peca.qtd, `OS #${osExistente.numeroOS}`);
          }
        }
        dados.estoqueBaixado = true;
      }
      salvo = await DB.update('ordens_servico', osExistente.id, dados);
      toast('OS atualizada!');
    } else {
      const numeroOS = await proximoContador('os');
      salvo = await DB.add('ordens_servico', { ...dados, numeroOS, estoqueBaixado: false });
      toast(`OS #${numeroOS} criada!`);
    }
    fecharModal();
    await carregarDadosBase();
    renderOS();
    if (!osEmEdicao) imprimirOSEntrada(salvo);
  });
}

async function excluirOS(id) {
  if (!confirm('Excluir esta Ordem de Serviço? O estoque das peças utilizadas será devolvido automaticamente (se já tinha sido baixado).')) return;
  const os = state.ordens.find(o => o.id === id);
  if (os) await estornarEstoquePecasOS(os);
  await DB.remove('ordens_servico', id);
  await carregarDadosBase();
  renderOS();
  toast('OS excluída e estoque devolvido.');
}

async function registrarPagamentoOS(id) {
  const os = state.ordens.find(o => o.id === id);
  abrirModal(`Registrar pagamento — OS #${os.numeroOS}`, `
    <form id="form-pag-os" class="form-grid">
      <label>Valor a pagar (R$)*<input type="number" step="0.01" id="pag-valor" value="${os.valorTotal}" required></label>
      <label>Forma de pagamento
        <select id="pag-forma"><option>Dinheiro</option><option>PIX</option><option>Cartão Débito</option><option>Cartão Crédito</option></select>
      </label>
      <button type="submit" class="btn btn-primary">Confirmar pagamento</button>
    </form>`);
  $('#form-pag-os').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.caixaSessao) { toast('Abra o caixa para registrar pagamentos.', 'erro'); fecharModal(); return irParaView('caixa'); }
    const valor = parseFloat($('#pag-valor').value);
    const forma = $('#pag-forma').value;
    await DB.add('caixa_movimentos', { sessaoId: state.caixaSessao.id, tipo: 'pagamento_os', descricao: `Pagamento OS #${os.numeroOS}`, formaPagamento: forma, valor });
    await DB.update('ordens_servico', os.id, { pago: true, formaPagamentoOS: forma });
    fecharModal(); await carregarDadosBase(); renderOS();
    toast('Pagamento registrado!');
    // Ao finalizar a OS, imprime SOMENTE o cupom e a garantia da OS — nunca os de venda de produto
    imprimirCupomOS(os, valor, forma);
  });
}

// Cupom de fechamento/pagamento da OS (peças + mão de obra) — específico de assistência técnica,
// nunca deve ser confundido com o recibo de venda de produto do PDV.
function imprimirCupomOS(os, valorPago, formaPagamento) {
  const itensRecibo = (os.pecas || []).map(p => ({ nome: p.nome, qtd: p.qtd, valorUnit: p.valor }));
  if (Number(os.valorMaoObra) > 0) {
    itensRecibo.push({ nome: 'Mão de obra', qtd: 1, valorUnit: Number(os.valorMaoObra) });
  }
  // A garantia sempre conta a partir da data de entrega do aparelho (não da data em que o
  // pagamento foi registrado/impresso) — precisa bater com o Termo de Garantia oficial abaixo.
  const dataBaseGarantia = os.dataEntrega || hojeISO();
  const dataFinal = somarDias(dataBaseGarantia, os.garantiaDias);
  imprimirHTML(`
    <div class="doc-imp">
      <h1>RECIBO DE SERVIÇO — OS Nº ${os.numeroOS}</h1>
      <div class="linha-info"><span>Assistência</span><span>${state.config.nome}${state.config.cnpj ? ' · CNPJ ' + state.config.cnpj : ''}</span></div>
      <div class="linha-info"><span>Data</span><span>${apenasData(hojeISO())}</span></div>
      <div class="linha-info"><span>Hora</span><span>${formatHora(hojeISO())}</span></div>
      <div class="linha-info"><span>Cliente</span><span>${os.clienteNome}</span></div>
      <div class="linha-info"><span>Aparelho</span><span>${os.aparelho} — ${os.marca||''} ${os.modelo||''}</span></div>
      ${itensRecibo.length ? linhasItensRecibo(itensRecibo) : ''}
      <h2 style="text-align:right">Total: ${formatMoeda(valorPago)} — ${formaPagamento}</h2>
      <p style="font-size:11px;color:#666">Garantia do serviço até ${apenasData(dataFinal)} (${os.garantiaDias} dias a partir da entrega), conforme termo de garantia de conserto.</p>
    </div>`);
  setTimeout(() => imprimirTermoGarantiaOS(os), 400);
}

function imprimirOSEntrada(os) {
  imprimirHTML(`
    <div class="doc-imp">
      <h1>ORDEM DE SERVIÇO Nº ${os.numeroOS} — ENTRADA</h1>
      <div class="linha-info"><span>Assistência</span><span>${state.config.nome}${state.config.cnpj ? ' · CNPJ ' + state.config.cnpj : ''}</span></div>
      <div class="linha-info"><span>Endereço / Contato</span><span>${state.config.endereco || '—'} · ${state.config.whatsapp || '—'}</span></div>
      <div class="linha-info"><span>Data de entrada</span><span>${apenasData(os.criadoEm || hojeISO())}</span></div>
      <div class="linha-info"><span>Hora de entrada</span><span>${formatHora(os.criadoEm || hojeISO())}</span></div>
      <div class="linha-info"><span>Cliente</span><span>${os.clienteNome} · ${os.telefoneCliente||''}</span></div>
      <div class="linha-info"><span>Aparelho</span><span>${os.aparelho} — ${os.marca||''} ${os.modelo||''}</span></div>
      <div class="linha-info"><span>IMEI</span><span>${os.imei||'—'}</span></div>
      <div class="linha-info"><span>Estado físico</span><span>${os.estadoFisico||'—'}</span></div>
      <h2>Defeito relatado</h2><p style="font-size:12.5px">${os.defeitoRelatado||'—'}</p>
      <h2>Status atual</h2><p style="font-size:12.5px">${os.status}</p>
      <div class="assinaturas">
        <div class="assinatura-box">Assinatura do cliente</div>
        <div class="assinatura-box">Assinatura da assistência</div>
      </div>
    </div>`);
}

function imprimirTermoGarantiaOS(os) {
  const dataEntrega = os.dataEntrega || hojeISO();
  const dataFinal = somarDias(dataEntrega, os.garantiaDias);
  const cliente = state.clientes.find(c => c.id === os.clienteId);
  const texto = `A assistência técnica concede garantia de ${os.garantiaDias} dias a partir da data de entrega do aparelho ao cliente, referente exclusivamente ao serviço executado e às peças substituídas nesta Ordem de Serviço.

A garantia cobre apenas o defeito relacionado ao serviço realizado.

A garantia não cobre:
- Novos defeitos não relacionados ao serviço executado;
- Quedas;
- Quebra de tela;
- Contato com água ou umidade;
- Oxidação;
- Mau uso;
- Tentativa de reparo por terceiros;
- Aparelho aberto por terceiros;
- Danos causados por carregadores ou acessórios inadequados;
- Problemas causados por software, vírus, senha, conta Google, iCloud ou bloqueios de segurança;
- Perda de dados, fotos, vídeos, aplicativos ou arquivos pessoais.

O cliente declara estar ciente de que a assistência técnica não se responsabiliza por dados armazenados no aparelho, sendo responsabilidade do cliente realizar backup antes do serviço, quando possível.

Para acionar a garantia, o cliente deverá apresentar este termo e a Ordem de Serviço.

Após análise técnica, caso seja confirmado defeito relacionado ao serviço executado, a assistência poderá realizar novo reparo sem custo dentro do prazo de garantia.

Declaro estar ciente das condições acima.`;
  imprimirHTML(`
    <div class="doc-imp">
      <h1>TERMO DE GARANTIA DE CONSERTO</h1>
      <div class="linha-info"><span>Assistência</span><span>${state.config.nome}${state.config.cnpj ? ' · CNPJ ' + state.config.cnpj : ''}</span></div>
      <div class="linha-info"><span>Endereço</span><span>${state.config.endereco || '—'}</span></div>
      <div class="linha-info"><span>Telefone/WhatsApp</span><span>${state.config.whatsapp || '—'}</span></div>
      <div class="linha-info"><span>Cliente</span><span>${os.clienteNome}</span></div>
      <div class="linha-info"><span>CPF do cliente</span><span>${cliente ? cliente.documento || '—' : '—'}</span></div>
      <div class="linha-info"><span>Aparelho</span><span>${os.aparelho} — ${os.marca||''}/${os.modelo||''}</span></div>
      <div class="linha-info"><span>IMEI</span><span>${os.imei||'—'}</span></div>
      <div class="linha-info"><span>Serviço realizado</span><span>${os.servicoRealizar||os.diagnosticoTecnico||'—'}</span></div>
      <div class="linha-info"><span>Peças trocadas</span><span>${(os.pecas||[]).map(p=>p.nome).join(', ')||'—'}</span></div>
      <div class="linha-info"><span>Valor pago</span><span>${formatMoeda(os.valorTotal)}</span></div>
      <div class="linha-info"><span>Data de entrega</span><span>${apenasData(dataEntrega)}</span></div>
      <div class="linha-info"><span>Garantia até</span><span>${apenasData(dataFinal)}</span></div>
      <div class="linha-info"><span>Número da OS</span><span>#${os.numeroOS}</span></div>
      <p class="clausulas">${texto}</p>
      <div class="assinaturas">
        <div class="assinatura-box">Assinatura do cliente</div>
        <div class="assinatura-box">Assinatura da assistência</div>
      </div>
    </div>`);
}

async function renderOS() {
  const busca = ($('#os-busca').value || '').toLowerCase();
  const filtroStatus = $('#os-filtro-status').value;
  const lista = state.ordens.filter(o =>
    (!filtroStatus || o.status === filtroStatus) &&
    (!busca || String(o.numeroOS).includes(busca) || (o.clienteNome||'').toLowerCase().includes(busca) || (o.aparelho||'').toLowerCase().includes(busca))
  ).sort((a,b) => paraData(b.criadoEm) - paraData(a.criadoEm));

  $('#os-lista-body').innerHTML = lista.length ? lista.map(o => `
    <tr>
      <td><span style="font-family:var(--mono)">#${o.numeroOS}</span></td>
      <td>${apenasData(o.criadoEm)}</td>
      <td>${o.clienteNome}</td>
      <td>${o.aparelho} ${o.modelo?('· '+o.modelo):''}</td>
      <td>${badgeStatusOS(o.status)}</td>
      <td>${formatMoeda(o.valorTotal)}</td>
      <td class="acoes-cell">
        <button class="btn btn-sm btn-outline" onclick='abrirModalOSPorId("${o.id}")'>Editar</button>
        <button class="btn btn-sm btn-outline" onclick='imprimirOSEntradaPorId("${o.id}")'>OS</button>
        <button class="btn btn-sm btn-outline" onclick='imprimirTermoGarantiaOSPorId("${o.id}")'>Garantia</button>
        <button class="btn btn-sm btn-outline" onclick="registrarPagamentoOS('${o.id}')">Pagamento</button>
        <button class="btn btn-sm btn-danger" onclick="excluirOS('${o.id}')">Excluir</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="7"><div class="vazio-msg">Nenhuma OS encontrada.</div></td></tr>`;
}
function abrirModalOSPorId(id) { abrirModalOS(state.ordens.find(o => o.id === id)); }
function imprimirOSEntradaPorId(id) { imprimirOSEntrada(state.ordens.find(o => o.id === id)); }
function imprimirTermoGarantiaOSPorId(id) { imprimirTermoGarantiaOS(state.ordens.find(o => o.id === id)); }

$('#btn-nova-os').addEventListener('click', () => abrirModalOS());
$('#os-busca').addEventListener('input', renderOS);
$('#os-filtro-status').addEventListener('change', renderOS);

/* ===========================================================
   CAIXA
=========================================================== */
async function renderCaixa() {
  const sessoes = await DB.getAll('caixa_sessoes');
  state.caixaSessao = sessoes.find(c => c.status === 'Aberto') || null;
  $('#caixa-status-badge').textContent = state.caixaSessao ? 'Aberto' : 'Fechado';
  $('#caixa-status-badge').className = 'badge ' + (state.caixaSessao ? 'badge-aberto' : 'badge-fechado');
  $('#btn-abrir-caixa').disabled = !!state.caixaSessao;
  $('#btn-fechar-caixa').disabled = !state.caixaSessao;
  $('#btn-suprimento').disabled = !state.caixaSessao;
  $('#btn-sangria').disabled = !state.caixaSessao;

  const movimentos = state.caixaSessao ? (await DB.getAll('caixa_movimentos')).filter(m => m.sessaoId === state.caixaSessao.id) : [];
  const porForma = {};
  let totalEntradas = 0, totalSaidas = 0;
  movimentos.forEach(m => {
    const valor = Number(m.valor) || 0;
    if (m.tipo === 'sangria') totalSaidas += valor; else totalEntradas += valor;
    if (m.formaPagamento) porForma[m.formaPagamento] = (porForma[m.formaPagamento] || 0) + (m.tipo === 'sangria' ? -valor : valor);
  });
  const saldo = (state.caixaSessao ? Number(state.caixaSessao.valorAbertura) : 0) + totalEntradas - totalSaidas;

  $('#caixa-resumo-cards').innerHTML = `
    <div class="stat-card accent"><span>Saldo atual</span><strong>${formatMoeda(saldo)}</strong><small>${state.caixaSessao ? 'caixa aberto' : 'caixa fechado'}</small></div>
    <div class="stat-card accent-green"><span>Entradas</span><strong>${formatMoeda(totalEntradas)}</strong></div>
    <div class="stat-card accent-red"><span>Saídas / Sangrias</span><strong>${formatMoeda(totalSaidas)}</strong></div>
    ${Object.entries(porForma).map(([forma,val]) => `<div class="stat-card"><span>${forma}</span><strong>${formatMoeda(val)}</strong></div>`).join('')}
  `;

  $('#caixa-movimentos-body').innerHTML = movimentos.length ? movimentos.sort((a,b)=>paraData(b.criadoEm)-paraData(a.criadoEm)).map(m => `
    <tr><td>${formatData(m.criadoEm)}</td><td>${m.tipo}</td><td>${m.descricao}</td><td>${m.formaPagamento||'—'}</td><td>${formatMoeda(m.valor)}</td></tr>
  `).join('') : `<tr><td colspan="5"><div class="vazio-msg">Nenhuma movimentação nesta sessão.</div></td></tr>`;
}

$('#btn-abrir-caixa').addEventListener('click', () => {
  abrirModal('Abrir caixa', `
    <form id="form-abrir-caixa" class="form-grid">
      <label>Valor inicial em caixa (R$)*<input type="number" step="0.01" id="abertura-valor" value="0" required></label>
      <button type="submit" class="btn btn-primary">Abrir caixa</button>
    </form>`);
  $('#form-abrir-caixa').addEventListener('submit', async e => {
    e.preventDefault();
    await DB.add('caixa_sessoes', { status: 'Aberto', valorAbertura: parseFloat($('#abertura-valor').value)||0, operadorAbertura: state.usuario.usuario });
    fecharModal(); await renderCaixa();
    toast('Caixa aberto!');
  });
});

$('#btn-suprimento').addEventListener('click', () => movimentoCaixa('suprimento', 'Suprimento (entrada)'));
$('#btn-sangria').addEventListener('click', () => movimentoCaixa('sangria', 'Sangria (retirada)'));

function movimentoCaixa(tipo, titulo) {
  abrirModal(titulo, `
    <form id="form-mov-caixa" class="form-grid">
      <label>Valor (R$)*<input type="number" step="0.01" id="mov-caixa-valor" required></label>
      <label>Descrição<input type="text" id="mov-caixa-desc" placeholder="Motivo"></label>
      <button type="submit" class="btn btn-primary">Confirmar</button>
    </form>`);
  $('#form-mov-caixa').addEventListener('submit', async e => {
    e.preventDefault();
    await DB.add('caixa_movimentos', {
      sessaoId: state.caixaSessao.id, tipo, descricao: $('#mov-caixa-desc').value || titulo,
      formaPagamento: 'Dinheiro', valor: parseFloat($('#mov-caixa-valor').value)
    });
    fecharModal(); await renderCaixa();
    toast('Movimentação registrada!');
  });
}

$('#btn-fechar-caixa').addEventListener('click', async () => {
  const movimentos = (await DB.getAll('caixa_movimentos')).filter(m => m.sessaoId === state.caixaSessao.id);
  const totalEntradas = movimentos.filter(m=>m.tipo!=='sangria').reduce((s,m)=>s+Number(m.valor),0);
  const totalSaidas = movimentos.filter(m=>m.tipo==='sangria').reduce((s,m)=>s+Number(m.valor),0);
  const saldoEsperado = Number(state.caixaSessao.valorAbertura) + totalEntradas - totalSaidas;

  abrirModal('Fechar caixa — conferência', `
    <form id="form-fechar-caixa" class="form-grid">
      <div class="span2" style="background:var(--bg);border-radius:8px;padding:10px 12px;font-size:13px">
        <div class="linha-info" style="display:flex;justify-content:space-between;margin:2px 0"><span>Abertura</span><strong>${formatMoeda(state.caixaSessao.valorAbertura)}</strong></div>
        <div class="linha-info" style="display:flex;justify-content:space-between;margin:2px 0"><span>Entradas</span><strong>${formatMoeda(totalEntradas)}</strong></div>
        <div class="linha-info" style="display:flex;justify-content:space-between;margin:2px 0"><span>Saídas/Sangrias</span><strong>${formatMoeda(totalSaidas)}</strong></div>
        <div class="linha-info" style="display:flex;justify-content:space-between;margin:6px 0 0;border-top:1px dashed var(--borda);padding-top:6px"><span>Saldo esperado no caixa</span><strong>${formatMoeda(saldoEsperado)}</strong></div>
      </div>
      <label class="span2">Valor contado fisicamente no caixa (R$)*
        <input type="number" step="0.01" id="fechamento-valor-contado" required autofocus placeholder="Conte o dinheiro antes de confirmar">
      </label>
      <div class="span2" id="fechamento-diferenca-preview" style="font-size:13px;font-weight:600"></div>
      <label class="span2">Observações do fechamento<textarea id="fechamento-obs" placeholder="Ex: diferença justificada por troco, etc."></textarea></label>
      <button type="submit" class="btn btn-danger">Confirmar fechamento definitivo</button>
    </form>`);

  const inputContado = $('#fechamento-valor-contado');
  const preview = $('#fechamento-diferenca-preview');
  inputContado.addEventListener('input', () => {
    if (inputContado.value === '') { preview.textContent = ''; return; }
    const diferenca = Number(inputContado.value) - saldoEsperado;
    if (Math.abs(diferenca) < 0.005) {
      preview.innerHTML = `<span style="color:var(--verde)">✓ Confere exatamente com o saldo esperado.</span>`;
    } else if (diferenca > 0) {
      preview.innerHTML = `<span style="color:var(--verde)">Sobra de ${formatMoeda(diferenca)} em relação ao esperado.</span>`;
    } else {
      preview.innerHTML = `<span style="color:var(--vermelho)">Falta de ${formatMoeda(Math.abs(diferenca))} em relação ao esperado.</span>`;
    }
  });

  $('#form-fechar-caixa').addEventListener('submit', async (e) => {
    e.preventDefault();
    const valorContado = parseFloat(inputContado.value);
    if (isNaN(valorContado)) return;
    const diferenca = valorContado - saldoEsperado;
    if (!confirm(`Confirmar fechamento definitivo do caixa?\n\nSaldo esperado: ${formatMoeda(saldoEsperado)}\nValor contado: ${formatMoeda(valorContado)}\nDiferença: ${formatMoeda(diferenca)}\n\nEsta ação não pode ser desfeita.`)) return;

    const sessaoFechada = {
      ...state.caixaSessao,
      status: 'Fechado',
      saldoFinal: saldoEsperado,
      valorContado,
      diferenca,
      observacoesFechamento: $('#fechamento-obs').value.trim(),
      fechadoEm: hojeISO(),
      operadorFechamento: state.usuario.usuario
    };
    await DB.update('caixa_sessoes', state.caixaSessao.id, {
      status: 'Fechado', saldoFinal: saldoEsperado, valorContado, diferenca,
      observacoesFechamento: sessaoFechada.observacoesFechamento,
      fechadoEm: sessaoFechada.fechadoEm, operadorFechamento: sessaoFechada.operadorFechamento
    });
    fecharModal();

    imprimirHTML(`
      <div class="doc-imp">
        <h1>RELATÓRIO DE FECHAMENTO DE CAIXA</h1>
        <div class="linha-info"><span>Loja</span><span>${state.config.nome}</span></div>
        <div class="linha-info"><span>Abertura</span><span>${formatData(state.caixaSessao.criadoEm)} — ${formatMoeda(state.caixaSessao.valorAbertura)}</span></div>
        <div class="linha-info"><span>Operador abertura</span><span>${state.caixaSessao.operadorAbertura||'—'}</span></div>
        <div class="linha-info"><span>Fechamento</span><span>${formatData(sessaoFechada.fechadoEm)}</span></div>
        <div class="linha-info"><span>Operador fechamento</span><span>${sessaoFechada.operadorFechamento}</span></div>
        <div class="linha-info"><span>Total entradas</span><span>${formatMoeda(totalEntradas)}</span></div>
        <div class="linha-info"><span>Total saídas/sangrias</span><span>${formatMoeda(totalSaidas)}</span></div>
        <div class="linha-info"><span>Saldo esperado (sistema)</span><span><strong>${formatMoeda(saldoEsperado)}</strong></span></div>
        <div class="linha-info"><span>Valor contado (conferência)</span><span><strong>${formatMoeda(valorContado)}</strong></span></div>
        <div class="linha-info"><span>Diferença</span><span><strong>${diferenca >= 0 ? '+' : ''}${formatMoeda(diferenca)} ${Math.abs(diferenca) < 0.005 ? '(confere)' : (diferenca > 0 ? '(sobra)' : '(falta)')}</strong></span></div>
        ${sessaoFechada.observacoesFechamento ? `<div class="linha-info"><span>Observações</span><span>${sessaoFechada.observacoesFechamento}</span></div>` : ''}
        <table><thead><tr><th>Hora</th><th>Tipo</th><th>Descrição</th><th>Forma</th><th>Valor</th></tr></thead>
          <tbody>${movimentos.map(m=>`<tr><td>${formatData(m.criadoEm)}</td><td>${m.tipo}</td><td>${m.descricao}</td><td>${m.formaPagamento||'—'}</td><td>${formatMoeda(m.valor)}</td></tr>`).join('')}</tbody></table>
        <div class="assinaturas">
          <div class="assinatura-box">Assinatura do operador</div>
          <div class="assinatura-box">Assinatura da conferência</div>
        </div>
      </div>`);

    await renderCaixa();
    toast('Caixa fechado e registrado com sucesso!');
  });
});

async function abrirHistoricoCaixa() {
  const sessoes = (await DB.getAll('caixa_sessoes')).filter(s => s.status === 'Fechado')
    .sort((a,b) => paraData(b.fechadoEm||b.criadoEm) - paraData(a.fechadoEm||a.criadoEm));
  const html = sessoes.length ? `
    <table class="tabela-padrao">
      <thead><tr><th>Abertura</th><th>Fechamento</th><th>Operador</th><th>Abertura (R$)</th><th>Saldo esperado</th><th>Contado</th><th>Diferença</th></tr></thead>
      <tbody>${sessoes.map(s => {
        const dif = Number(s.diferenca||0);
        const corDif = Math.abs(dif) < 0.005 ? 'inherit' : (dif > 0 ? 'var(--verde)' : 'var(--vermelho)');
        return `<tr>
          <td>${formatData(s.criadoEm)}</td>
          <td>${s.fechadoEm ? formatData(s.fechadoEm) : '—'}</td>
          <td>${s.operadorFechamento || s.operadorAbertura || '—'}</td>
          <td>${formatMoeda(s.valorAbertura)}</td>
          <td>${formatMoeda(s.saldoFinal)}</td>
          <td>${s.valorContado != null ? formatMoeda(s.valorContado) : '—'}</td>
          <td style="color:${corDif};font-weight:600">${s.diferenca != null ? (dif>=0?'+':'')+formatMoeda(dif) : '—'}</td>
        </tr>${s.observacoesFechamento ? `<tr><td colspan="7" style="font-size:12px;color:var(--texto-sec);padding-top:0">Obs: ${s.observacoesFechamento}</td></tr>` : ''}`;
      }).join('')}</tbody>
    </table>` : `<div class="vazio-msg">Nenhum fechamento de caixa registrado ainda.</div>`;
  abrirModal('Histórico de fechamentos de caixa', html, { grande: true });
}
$('#btn-historico-caixa').addEventListener('click', abrirHistoricoCaixa);

/* ===========================================================
   RELATÓRIOS
=========================================================== */
function periodoSelecionado() {
  const ini = $('#rel-data-ini').value ? new Date($('#rel-data-ini').value + 'T00:00:00') : new Date('2000-01-01');
  const fim = $('#rel-data-fim').value ? new Date($('#rel-data-fim').value + 'T23:59:59') : new Date('2100-01-01');
  return { ini, fim };
}

$('#btn-gerar-relatorio').addEventListener('click', () => {
  const tipo = $('#rel-tipo').value;
  const { ini, fim } = periodoSelecionado();
  const geradores = {
    'vendas': relVendasPeriodo, 'produtos-mais-vendidos': relProdutosMaisVendidos, 'lucro': relLucroEstimado,
    'estoque-baixo': relEstoqueBaixo, 'mov-estoque': relMovEstoque, 'os-abertas': relOSAbertas,
    'os-finalizadas': relOSFinalizadas, 'servicos-mais-realizados': relServicosMaisRealizados,
    'faturamento-consertos': relFaturamentoConsertos, 'faturamento-total': relFaturamentoTotal
  };
  geradores[tipo](ini, fim);
});
$('#btn-imprimir-relatorio').addEventListener('click', () => {
  imprimirHTML(`<div class="doc-imp"><h1>${$('#rel-tipo').selectedOptions[0].textContent}</h1>${$('#relatorio-resultado').innerHTML}</div>`);
});

function tabelaSimples(colunas, linhas) {
  return `<table class="tabela-padrao"><thead><tr>${colunas.map(c=>`<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${linhas.length ? linhas.map(l => `<tr>${l.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${colunas.length}"><div class="vazio-msg">Nenhum dado no período selecionado.</div></td></tr>`}</tbody></table>`;
}

function relVendasPeriodo(ini, fim) {
  const vendas = state.vendas.filter(v => { const d = paraData(v.criadoEm); return d>=ini && d<=fim; });
  const total = vendas.reduce((s,v)=>s+Number(v.total),0);
  $('#relatorio-resultado').innerHTML = `<h3>Vendas por período (${vendas.length} pedidos — ${formatMoeda(total)})</h3>` +
    tabelaSimples(['Pedido','Data','Cliente','Total','Pagamento'], vendas.map(v=>[`#${v.numeroPedido}`, formatData(v.criadoEm), v.clienteNome, formatMoeda(v.total), v.formaPagamento]));
}
function relProdutosMaisVendidos(ini, fim) {
  const contagem = {};
  state.vendas.filter(v => { const d = paraData(v.criadoEm); return d>=ini && d<=fim; }).forEach(v => {
    v.itens.forEach(i => { contagem[i.nome] = (contagem[i.nome]||0) + i.qtd; });
  });
  const linhas = Object.entries(contagem).sort((a,b)=>b[1]-a[1]).map(([nome,qtd])=>[nome,qtd]);
  $('#relatorio-resultado').innerHTML = `<h3>Produtos mais vendidos</h3>` + tabelaSimples(['Produto','Quantidade vendida'], linhas);
}
function relLucroEstimado(ini, fim) {
  let lucro = 0, receita = 0, custo = 0;
  state.vendas.filter(v => { const d = paraData(v.criadoEm); return d>=ini && d<=fim; }).forEach(v => {
    v.itens.forEach(i => {
      receita += i.qtd * i.valorUnit;
      const prod = state.produtos.find(p => p.id === i.produtoId);
      custo += i.qtd * (prod ? Number(prod.precoCusto||0) : 0);
    });
  });
  lucro = receita - custo;
  $('#relatorio-resultado').innerHTML = `<h3>Lucro estimado</h3>${tabelaSimples(['Receita','Custo estimado','Lucro estimado'], [[formatMoeda(receita), formatMoeda(custo), formatMoeda(lucro)]])}`;
}
function relEstoqueBaixo() {
  const baixo = state.produtos.filter(p => Number(p.estoque) <= Number(p.estoqueMinimo||0));
  $('#relatorio-resultado').innerHTML = `<h3>Produtos com estoque baixo</h3>` + tabelaSimples(['Produto','Estoque atual','Estoque mínimo'], baixo.map(p=>[p.nome,p.estoque,p.estoqueMinimo]));
}
async function relMovEstoque(ini, fim) {
  const movs = (await DB.getAll('movimentacoes_estoque')).filter(m => { const d = paraData(m.criadoEm); return d>=ini && d<=fim; });
  $('#relatorio-resultado').innerHTML = `<h3>Movimentação de estoque</h3>` + tabelaSimples(['Data','Produto','Tipo','Qtd','Motivo'],
    movs.map(m => { const prod = state.produtos.find(p=>p.id===m.produtoId); return [formatData(m.criadoEm), prod?prod.nome:'—', m.tipo, m.quantidade, m.motivo||'—']; }));
}
function relOSAbertas() {
  const lista = state.ordens.filter(o => !['Entregue','Cancelada'].includes(o.status));
  $('#relatorio-resultado').innerHTML = `<h3>OS abertas (${lista.length})</h3>` + tabelaSimples(['OS','Data','Cliente','Aparelho','Status'], lista.map(o=>[`#${o.numeroOS}`, apenasData(o.criadoEm), o.clienteNome, o.aparelho, o.status]));
}
function relOSFinalizadas(ini, fim) {
  const lista = state.ordens.filter(o => o.status==='Entregue' && o.dataEntrega && paraData(o.dataEntrega)>=ini && paraData(o.dataEntrega)<=fim);
  $('#relatorio-resultado').innerHTML = `<h3>OS finalizadas (${lista.length})</h3>` + tabelaSimples(['OS','Entrega','Cliente','Aparelho','Total'], lista.map(o=>[`#${o.numeroOS}`, apenasData(o.dataEntrega), o.clienteNome, o.aparelho, formatMoeda(o.valorTotal)]));
}
function relServicosMaisRealizados() {
  const contagem = {};
  state.ordens.filter(o=>o.status==='Entregue').forEach(o => { const chave = o.servicoRealizar || 'Não especificado'; contagem[chave] = (contagem[chave]||0)+1; });
  $('#relatorio-resultado').innerHTML = `<h3>Serviços mais realizados</h3>` + tabelaSimples(['Serviço','Quantidade'], Object.entries(contagem).sort((a,b)=>b[1]-a[1]));
}
function relFaturamentoConsertos(ini, fim) {
  const lista = state.ordens.filter(o => o.status==='Entregue' && o.dataEntrega && paraData(o.dataEntrega)>=ini && paraData(o.dataEntrega)<=fim);
  const total = lista.reduce((s,o)=>s+Number(o.valorTotal||0),0);
  $('#relatorio-resultado').innerHTML = `<h3>Faturamento de consertos: ${formatMoeda(total)}</h3>` + tabelaSimples(['OS','Entrega','Cliente','Total'], lista.map(o=>[`#${o.numeroOS}`, apenasData(o.dataEntrega), o.clienteNome, formatMoeda(o.valorTotal)]));
}
function relFaturamentoTotal(ini, fim) {
  const totalVendas = state.vendas.filter(v=>{const d=paraData(v.criadoEm);return d>=ini&&d<=fim;}).reduce((s,v)=>s+Number(v.total),0);
  const totalOS = state.ordens.filter(o=>o.status==='Entregue'&&o.dataEntrega&&paraData(o.dataEntrega)>=ini&&paraData(o.dataEntrega)<=fim).reduce((s,o)=>s+Number(o.valorTotal||0),0);
  $('#relatorio-resultado').innerHTML = `<h3>Faturamento total no período</h3>` + tabelaSimples(['Origem','Valor'], [['Vendas (PDV)', formatMoeda(totalVendas)], ['Assistência técnica', formatMoeda(totalOS)], ['Total geral', formatMoeda(totalVendas+totalOS)]]);
}

/* ===========================================================
   CONFIGURAÇÕES
=========================================================== */
async function renderConfig() {
  $('#cfg-nome').value = state.config.nome || '';
  $('#cfg-cnpj').value = state.config.cnpj || '';
  $('#cfg-endereco').value = state.config.endereco || '';
  $('#cfg-whatsapp').value = state.config.whatsapp || '';
  $('#cfg-garantia-produto').value = state.config.garantiaProduto ?? 30;
  $('#cfg-garantia-conserto').value = state.config.garantiaConserto ?? 30;
  $('#cfg-firebase-status').textContent = MODO_ARMAZENAMENTO;

  const usuarios = await DB.getAll('usuarios');
  state.usuariosCache = usuarios;
  const podeGerenciar = state.usuario.nivel === 'Admin';
  $('#usuarios-lista-body').innerHTML = usuarios.map(u => `
    <tr>
      <td>${u.usuario} <br><span style="font-size:11px;color:var(--texto-sec)">${u.nome||''}</span></td>
      <td>${u.nivel}</td>
      <td class="acoes-cell">
        ${podeGerenciar ? `<button class="btn btn-sm btn-outline" onclick='editarUsuario("${u.id}")'>Editar</button>
        <button class="btn btn-sm btn-danger" onclick="excluirUsuario('${u.id}')">Excluir</button>` : '<span style="color:var(--texto-sec);font-size:12px">Somente admin</span>'}
      </td>
    </tr>`).join('');
  $('#btn-novo-usuario').style.display = podeGerenciar ? '' : 'none';
}

$('#form-config-loja').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = {
    nome: $('#cfg-nome').value.trim(),
    cnpj: $('#cfg-cnpj').value.trim(),
    endereco: $('#cfg-endereco').value.trim(),
    whatsapp: $('#cfg-whatsapp').value.trim(),
    garantiaProduto: parseInt($('#cfg-garantia-produto').value) || 30,
    garantiaConserto: parseInt($('#cfg-garantia-conserto').value) || 30
  };
  await DB.setDocFixo('config', 'loja', dados);
  await carregarDadosBase();
  $('#nome-loja-side').textContent = state.config.nome || 'TechStore';
  toast('Dados da loja salvos!');
});

function formularioUsuario(u = {}) {
  return `
    <form id="form-usuario" class="form-grid">
      <label>Nome completo<input type="text" id="u-nome" value="${u.nome||''}"></label>
      <label>${USE_FIREBASE ? 'E-mail (login)*' : 'Usuário (login)*'}<input type="${USE_FIREBASE ? 'email' : 'text'}" id="u-login" value="${u.usuario||''}" required ${u.id?'readonly':''}></label>
      ${u.id
        ? (USE_FIREBASE ? `<div class="span2" style="font-size:12.5px;color:var(--texto-sec)">A senha não fica visível aqui. Use o botão abaixo para enviar um link de redefinição de senha para o e-mail do usuário.</div>`
                        : `<label>Senha*<input type="text" id="u-senha" value="${u.senha||''}" required></label>`)
        : `<label>Senha inicial*<input type="${USE_FIREBASE ? 'text' : 'text'}" id="u-senha" required minlength="6" placeholder="mínimo 6 caracteres"></label>`}
      <label>Nível de acesso
        <select id="u-nivel">
          <option ${u.nivel==='Admin'?'selected':''}>Admin</option>
          <option ${u.nivel==='Funcionário'?'selected':''}>Funcionário</option>
          <option ${u.nivel==='Técnico'?'selected':''}>Técnico</option>
        </select>
      </label>
      <label>Status
        <select id="u-ativo"><option value="true" ${u.ativo!==false?'selected':''}>Ativo</option><option value="false" ${u.ativo===false?'selected':''}>Inativo</option></select>
      </label>
      ${u.id && USE_FIREBASE ? `<button type="button" class="btn btn-outline span2" id="btn-resetar-senha">Enviar e-mail de redefinição de senha</button>` : ''}
      <button type="submit" class="btn btn-primary">${u.id ? 'Salvar alterações' : 'Criar usuário'}</button>
    </form>`;
}
$('#btn-novo-usuario').addEventListener('click', () => abrirModalUsuario());
function abrirModalUsuario(usuarioExistente = null) {
  abrirModal(usuarioExistente ? 'Editar usuário' : 'Novo usuário', formularioUsuario(usuarioExistente || {}));

  const btnReset = $('#btn-resetar-senha');
  if (btnReset) {
    btnReset.addEventListener('click', async () => {
      try {
        await FirebaseDB.enviarResetSenha(usuarioExistente.usuario);
        toast('E-mail de redefinição enviado para ' + usuarioExistente.usuario);
      } catch (erro) {
        console.error(erro);
        toast(traduzErroAuth(erro), 'erro');
      }
    });
  }

  $('#form-usuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = { nome: $('#u-nome').value.trim(), usuario: $('#u-login').value.trim(), nivel: $('#u-nivel').value, ativo: $('#u-ativo').value === 'true' };
    try {
      if (usuarioExistente) {
        await DB.update('usuarios', usuarioExistente.id, dados);
        toast('Usuário atualizado!');
      } else {
        const usuarios = await DB.getAll('usuarios');
        if (usuarios.some(u => u.usuario === dados.usuario)) return toast('Já existe um usuário com esse login.', 'erro');
        const senha = $('#u-senha').value;
        if (USE_FIREBASE) {
          const uid = await FirebaseDB.criarUsuarioAuth(dados.usuario, senha);
          await DB.setDocFixo('usuarios', uid, dados);
        } else {
          dados.senha = senha;
          await DB.add('usuarios', dados);
        }
        toast('Usuário criado!');
      }
      fecharModal(); renderConfig();
    } catch (erro) {
      console.error(erro);
      toast(traduzErroAuth(erro), 'erro');
    }
  });
}
function editarUsuario(id) { abrirModalUsuario(state.usuariosCache.find(u => u.id === id)); }
async function excluirUsuario(id) {
  if (state.usuariosCache.find(u=>u.id===id)?.usuario === state.usuario.usuario) return toast('Você não pode excluir seu próprio usuário.', 'erro');
  const aviso = USE_FIREBASE
    ? 'Excluir este usuário? Ele perde o acesso ao sistema imediatamente.\n\n(A conta de login continua existindo no Firebase Authentication — o Firebase não permite apagar contas de outras pessoas direto pelo navegador. Se quiser removê-la de vez, apague também em Firebase Console > Authentication.)'
    : 'Excluir este usuário?';
  if (!confirm(aviso)) return;
  await DB.remove('usuarios', id);
  renderConfig();
  toast('Usuário excluído. Acesso ao sistema revogado.');
}