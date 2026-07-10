/* ===========================================================
   firebase.js
   Camada de dados do sistema TechStore PDV.

   Este arquivo expõe um objeto global `DB` com métodos assíncronos
   (getAll, getById, add, update, remove) usados por todo o app.js.

   Por padrão o sistema roda 100% em localStorage (não precisa de
   nenhuma configuração para funcionar). Quando você tiver seu projeto
   Firebase pronto, siga o README.md, preencha o firebaseConfig abaixo
   e mude USE_FIREBASE para true — o app.js não precisa mudar nada,
   pois usa sempre a mesma interface DB.*
=========================================================== */

// -----------------------------------------------------------
// 1) LIGAR/DESLIGAR FIREBASE
// -----------------------------------------------------------
const USE_FIREBASE = true; // true = usa Firestore | false = usa localStorage

// -----------------------------------------------------------
// 2) CONFIGURAÇÃO DO SEU PROJETO FIREBASE
//    (pegue em: Firebase Console > Configurações do Projeto > Seus apps)
// -----------------------------------------------------------
const firebaseConfig = {
apiKey: "AIzaSyCUeliFCdxfASDcb-dVuTASXFYkyLK37qY",
  authDomain: "ribas-interativo.firebaseapp.com",
  projectId: "ribas-interativo",
  storageBucket: "ribas-interativo.firebasestorage.app",
  messagingSenderId: "715579473148",
  appId: "1:715579473148:web:493ee27d5522d085b62b79",
  measurementId: "G-V9M61MG356"
};

// -----------------------------------------------------------
// 3) COLEÇÕES USADAS NO SISTEMA
// -----------------------------------------------------------
const COLLECTIONS = [
  "usuarios", "clientes", "produtos", "vendas", "ordens_servico",
  "movimentacoes_estoque", "caixa_sessoes", "caixa_movimentos", "config"
];

/* =========================================================
   IMPLEMENTAÇÃO LOCAL (localStorage) — ativa por padrão
========================================================= */
const LocalDB = (() => {
  function chave(colecao) { return `techstore_${colecao}`; }

  function lerTudo(colecao) {
    try {
      return JSON.parse(localStorage.getItem(chave(colecao))) || [];
    } catch (e) { return []; }
  }

  function salvarTudo(colecao, arr) {
    localStorage.setItem(chave(colecao), JSON.stringify(arr));
  }

  function gerarId() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  return {
    async getAll(colecao) {
      return lerTudo(colecao);
    },
    async getById(colecao, id) {
      return lerTudo(colecao).find(item => item.id === id) || null;
    },
    async add(colecao, dados) {
      const arr = lerTudo(colecao);
      const novo = { id: gerarId(), ...dados, criadoEm: new Date().toISOString() };
      arr.push(novo);
      salvarTudo(colecao, arr);
      return novo;
    },
    async update(colecao, id, dados) {
      const arr = lerTudo(colecao);
      const idx = arr.findIndex(item => item.id === id);
      if (idx === -1) return null;
      arr[idx] = { ...arr[idx], ...dados, atualizadoEm: new Date().toISOString() };
      salvarTudo(colecao, arr);
      return arr[idx];
    },
    async remove(colecao, id) {
      const arr = lerTudo(colecao).filter(item => item.id !== id);
      salvarTudo(colecao, arr);
      return true;
    },
    async setDocFixo(colecao, id, dados) {
      // usado para documentos únicos, ex: config da loja
      const arr = lerTudo(colecao);
      const idx = arr.findIndex(item => item.id === id);
      if (idx === -1) arr.push({ id, ...dados });
      else arr[idx] = { ...arr[idx], ...dados };
      salvarTudo(colecao, arr);
    }
  };
})();

/* =========================================================
   IMPLEMENTAÇÃO FIREBASE (Firestore) — ativa quando USE_FIREBASE=true
   Requer incluir os SDKs do Firebase (compat) no index.html antes deste
   arquivo. Veja instruções completas no README.md.

   Exemplo de tags a adicionar no <head> do index.html:
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-storage-compat.js"></script>
========================================================= */
const FirebaseDB = (() => {
  let db = null, auth = null, storage = null;

  function init() {
    if (typeof firebase === "undefined") {
      console.error("SDK do Firebase não carregado. Adicione os <script> do Firebase no index.html (veja README.md).");
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    storage = firebase.storage();
  }

  return {
    init,
    getAuth: () => auth,
    getStorage: () => storage,
    async getAll(colecao) {
      const snap = await db.collection(colecao).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async getById(colecao, id) {
      const doc = await db.collection(colecao).doc(id).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async add(colecao, dados) {
      // IMPORTANTE: usamos uma string ISO simples (igual ao modo local), e não
      // firebase.firestore.FieldValue.serverTimestamp(). O serverTimestamp() volta
      // do Firestore como um objeto Timestamp (não uma string), e o app inteiro
      // espera poder fazer `new Date(criadoEm)` diretamente — daí o "Invalid Date".
      const criadoEm = new Date().toISOString();
      const payload = { ...dados, criadoEm };
      const ref = await db.collection(colecao).add(payload);
      return { id: ref.id, ...dados, criadoEm };
    },
    async update(colecao, id, dados) {
      const atualizadoEm = new Date().toISOString();
      await db.collection(colecao).doc(id).update({ ...dados, atualizadoEm });
      return this.getById(colecao, id);
    },
    async remove(colecao, id) {
      await db.collection(colecao).doc(id).delete();
      return true;
    },
    async setDocFixo(colecao, id, dados) {
      await db.collection(colecao).doc(id).set(dados, { merge: true });
    },
    async uploadArquivo(caminho, arquivo) {
      const ref = storage.ref().child(caminho);
      await ref.put(arquivo);
      return ref.getDownloadURL();
    }
  };
})();

/* =========================================================
   EXPORTA A INTERFACE ÚNICA `DB` USADA PELO app.js
========================================================= */
const DB = USE_FIREBASE ? FirebaseDB : LocalDB;
if (USE_FIREBASE) FirebaseDB.init();

// Flag global usada pelo app.js para saber o modo atual (exibido em Configurações)
const MODO_ARMAZENAMENTO = USE_FIREBASE ? "Firebase Firestore (nuvem)" : "Modo local (localStorage)";