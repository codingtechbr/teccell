# TechStore PDV — Sistema para Loja de Celulares e Assistência Técnica

Sistema web completo (HTML + CSS + JS puro) com PDV, Ordens de Serviço, estoque,
clientes, caixa, relatórios e termos de garantia imprimíveis.

## Como usar agora mesmo (sem configurar nada)

O sistema já funciona **100% localmente**, salvando os dados no `localStorage`
do navegador. Basta abrir o `index.html`:

1. Abra `index.html` no navegador (ou publique os arquivos em qualquer
   hospedagem estática — Netlify, Vercel, Firebase Hosting, etc).
2. Na tela de login, clique em **"Criar acesso admin (admin / admin123)"**.
3. Entre com usuário `admin` e senha `admin123`.
4. Vá em **Configurações** e preencha os dados reais da loja (nome, CNPJ,
   endereço, WhatsApp e prazos de garantia).
5. Cadastre produtos, clientes, e comece a vender / abrir OS.

⚠️ Importante: dados em `localStorage` ficam **só naquele navegador/computador**.
Para várias pessoas acessarem os mesmos dados ao mesmo tempo (de PCs diferentes),
é necessário ativar o Firebase — veja abaixo.

## Estrutura dos arquivos

```
index.html   → estrutura de todas as telas (login, dashboard, PDV, OS, etc.)
style.css    → todo o visual do sistema (tema, responsividade, impressão)
app.js       → toda a lógica: autenticação, PDV, estoque, OS, caixa, relatórios
firebase.js  → camada de dados (DB). Hoje usa localStorage; pode virar Firestore
README.md    → este arquivo
firestore.rules → regras de segurança prontas para quando ativar o Firestore
```

Todo o app fala com os dados **sempre através do objeto `DB`** (`DB.getAll`,
`DB.add`, `DB.update`, `DB.remove`, `DB.setDocFixo`). Isso significa que trocar
de localStorage para Firebase não exige tocar em `app.js` — só em `firebase.js`.

## Como ativar o Firebase (Firestore + Auth + Storage)

### 1. Crie um projeto no Firebase
- Acesse https://console.firebase.google.com
- Crie um novo projeto (pode desativar o Google Analytics).

### 2. Ative os produtos necessários
- **Firestore Database** → criar banco → modo produção → escolher região (ex: `southamerica-east1`).
- **Storage** → ativar (caso vá anexar fotos de aparelhos/comprovantes).
- **Authentication** não é obrigatório porque o sistema usa login próprio
  (usuário/senha guardados na coleção `usuarios`), mas você pode migrar para
  Firebase Authentication depois, se preferir mais segurança.

### 3. Pegue as credenciais do seu app web
- No Firebase Console: **Configurações do projeto → Geral → Seus apps → Web (ícone `</>`)**.
- Copie o objeto `firebaseConfig`.

### 4. Adicione os SDKs do Firebase no `index.html`
Antes da linha `<script src="firebase.js"></script>`, adicione:

```html
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-storage-compat.js"></script>
```

### 5. Configure o `firebase.js`
Abra `firebase.js` e:
1. Troque `const USE_FIREBASE = false;` por `const USE_FIREBASE = true;`
2. Cole suas credenciais em `firebaseConfig`.

Pronto — o sistema inteiro passa a usar o Firestore automaticamente, pois toda
a lógica em `app.js` usa a interface genérica `DB`.

### 6. Publique as regras do Firestore
Use o conteúdo do arquivo `firestore.rules` (veja abaixo) no console do
Firestore, em **Regras**, ou via Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore
# selecione seu projeto, e quando perguntar pelo arquivo de regras,
# aponte para o firestore.rules que veio junto com este sistema
firebase deploy --only firestore:rules
```

### 7. (Opcional) Upload de fotos do aparelho na OS
O `firebase.js` já expõe `FirebaseDB.uploadArquivo(caminho, arquivo)`, pronto
para receber um `<input type="file">` e devolver a URL pública da imagem via
Firebase Storage. Basta ligar esse input na tela de OS e salvar a URL retornada
no campo de fotos da Ordem de Serviço.

## Estrutura de dados (coleções)

| Coleção                | Descrição                                             |
|-------------------------|--------------------------------------------------------|
| `usuarios`              | login, senha, nome, nível (Admin/Funcionário/Técnico) |
| `clientes`               | cadastro de clientes                                  |
| `produtos`               | estoque, preços, categoria, garantia padrão           |
| `vendas`                 | pedidos do PDV, itens, forma de pagamento             |
| `ordens_servico`         | OS completas (aparelho, defeito, peças, status, etc.) |
| `movimentacoes_estoque` | histórico de entradas/saídas de estoque               |
| `caixa_sessoes`          | aberturas/fechamentos de caixa                        |
| `caixa_movimentos`       | vendas, pagamentos de OS, sangrias e suprimentos      |
| `config`                 | dados da loja (`doc: loja`) e contadores (`doc: contadores`) |

## Níveis de acesso

- **Admin**: acesso total, inclusive Configurações e gestão de usuários.
- **Funcionário**: acesso a PDV, OS, produtos, clientes, caixa e relatórios.
- **Técnico**: acesso a Dashboard, OS, produtos e clientes (sem PDV, Caixa e Configurações).

Edite as permissões em `app.js`, na função `aplicarPermissoes()`, se quiser
ajustar o que cada nível pode ver.

## Segurança — próximos passos recomendados

- Trocar o login por usuário/senha simples (atual) por **Firebase Authentication**
  real (e-mail/senha ou provedor), o que traz criptografia e recuperação de senha.
- Nunca deixe `USE_FIREBASE = true` com as `firestore.rules` de teste
  (`allow read, write: if true`) em produção — use as regras deste pacote,
  que exigem usuário autenticado.
- Trocar senhas de usuários salvas em texto puro por hash, caso migre a
  autenticação para dentro do próprio Firestore.

## Impressão

Todos os documentos (recibo de venda, termo de garantia de produto, OS de
entrada e termo de garantia de conserto) usam a função `imprimirHTML()` em
`app.js`, que joga o conteúdo em uma área oculta e chama `window.print()`.
No navegador, escolha **"Salvar como PDF"** na janela de impressão para gerar
o arquivo PDF.

## Personalização rápida

- **Cores/fonte**: edite as variáveis no topo do `style.css` (`:root { ... }`).
- **Textos dos termos de garantia**: estão dentro de `imprimirTermoGarantiaProduto()`
  e `imprimirTermoGarantiaOS()` em `app.js`.
- **Prazos de garantia padrão**: em Configurações → Dados da loja.
