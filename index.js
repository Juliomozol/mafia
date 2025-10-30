/**
 * Mafia - versão completa (single file)
 * Requisitos:
 *  - Node.js, discord.js v14
 *  - ENV: TOKEN, GUILD_ID, CHANNEL_ID
 *
 * Observações:
 *  - Lobby com /cidade (botões Entrar / Iniciar)
 *  - Ações via DM com botões listando os vivos
 *  - Aprendiz de Assassino pode salvar 1 vez na votação
 *  - Psicopata usa dado (1-6): ímpar = mata, par = salva
 *  - Quando alguém morre, o cargo é revelado publicamente
 *  - Caçador é revelado no início do jogo
 *  - Vitória: civis vencem se não restar máfia; máfia vence se (mafiasAlive >= 1 && civisAlive <= 2)
 */

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error('Faltando variáveis de ambiente TOKEN, GUILD_ID ou CHANNEL_ID.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/* ---------- Config do jogo ---------- */
const ROLE_POOL = [
  'Assassino',
  'Aprendiz de Assassino',
  'Psicopata',
  'Feiticeira',
  'Anjo',
  'Vidente',
  'Caçador',
  // O resto será "Civil"
];

let lobby = new Map(); // userId => username (entraram no lobby)
let jogo = null; // objeto com estado da partida se iniciou

/* ---------- Helpers ---------- */
function shuffle(a) { return a.sort(() => Math.random() - 0.5); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mention(id) { return `<@${id}>`; }
function hasRole(p, r) { return p.role === r; }

/* ---------- Slash command de criação do lobby (registrado por guild) ---------- */
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logado como ${client.user.tag}`);

  // Registra slash command /cidade no GUILD para deploy imediato
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const cmd = new SlashCommandBuilder()
    .setName('cidade')
    .setDescription('Abre o lobby do jogo Cidade Dorme (botões para entrar).')
    .toJSON();

  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [cmd] });
    console.log('Comando /cidade registrado para o servidor.');
  } catch (err) {
    console.error('Erro registrando comando:', err);
  }
});

/* ---------- Interações de Slash & Botões (lobby e ações) ---------- */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash /cidade -> cria lobby message com botões
    if (interaction.isChatInputCommand() && interaction.commandName === 'cidade') {
      if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({ content: 'Apenas administradores podem abrir o lobby.', ephemeral: true });
      }
      if (jogo) return interaction.reply({ content: 'Já existe um jogo em andamento.', ephemeral: true });

      lobby.clear();
      const entrarBtn = new ButtonBuilder().setCustomId('entrar_lobby').setLabel('🎮 Entrar no Jogo').setStyle(ButtonStyle.Success);
      const iniciarBtn = new ButtonBuilder().setCustomId('iniciar_jogo').setLabel('🚀 Iniciar Jogo (Admin)').setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(entrarBtn, iniciarBtn);

      await interaction.reply({
        content: '**LOBBY** — Clique em Entrar para participar. Quando todos estiverem, um admin deve clicar em Iniciar.',
        components: [row]
      });
      return;
    }

    // Botões
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'entrar_lobby') {
        if (jogo) return interaction.reply({ content: '⏳ Jogo já começou', ephemeral: true });
        if (lobby.has(interaction.user.id)) return interaction.reply({ content: 'Você já está no lobby.', ephemeral: true });
        lobby.set(interaction.user.id, interaction.user.username);
        return interaction.reply({ content: `✅ ${interaction.user.username} entrou no lobby! (${lobby.size})`, ephemeral: true });
      }

      if (id === 'iniciar_jogo') {
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.reply({ content: 'Apenas administradores podem iniciar o jogo.', ephemeral: true });
        }
        if (jogo) return interaction.reply({ content: 'Jogo já em andamento.', ephemeral: true });
        if (lobby.size < 5) return interaction.reply({ content: 'Mínimo 5 jogadores para iniciar.', ephemeral: true });

        await interaction.reply({ content: '🎲 Iniciando o jogo... enviando cargos via DM.', ephemeral: true });
        iniciarPartida(await interaction.channel.fetch());
        return;
      }

      // ações via botões terão customId com prefixos especiais: ex: target_123456
      // Essas são tratadas em collectors individuais (não aqui).
    }
  } catch (err) {
    console.error('Erro interaction create:', err);
  }
});

/* ---------- Função: iniciarPartida ---------- */
async function iniciarPartida(channel) {
  // monta objeto de jogo
  jogo = {
    channelId: CHANNEL_ID,
    players: new Map(), // userId -> { user, role, alive:true, usedAprendizSave:false, feiticeiraReviveUsed:false, feiticeiraPoisonUsed:false }
    round: 0,
    nightCount: 0,
  };

  // Distribui cargos - garante que papéis importantes existam (se jogadores < roles length, preenche com subset)
  const playerIds = Array.from(lobby.keys());
  let roles = [];
  // ensure at least these roles present if enough players
  const mandatory = ['Assassino', 'Aprendiz de Assassino', 'Psicopata', 'Feiticeira', 'Anjo', 'Vidente', 'Caçador'];
  for (let r of mandatory) roles.push(r);
  // fill remaining with Civis or extra Civis
  while (roles.length < playerIds.length) roles.push('Civil');
  roles = shuffle(roles).slice(0, playerIds.length);

  // assign
  for (let i = 0; i < playerIds.length; i++) {
    const id = playerIds[i];
    const role = roles[i] || 'Civil';
    jogo.players.set(id, {
      userId: id,
      username: lobby.get(id),
      role,
      alive: true,
      usedAprendizSave: false,
      feiticeiraReviveUsed: false,
      feiticeiraPoisonUsed: false
    });
  }

  // send DM with roles
  for (const [id, p] of jogo.players) {
    try {
      const user = await client.users.fetch(id);
      await user.send(`🎭 Seu cargo é **${p.role}**. Mantenha em segredo!`);
    } catch (err) {
      console.warn(`Não foi possível enviar DM para ${p.username}.`);
      const chan = await client.channels.fetch(channel.id);
      await chan.send(`⚠️ ${p.username}, habilite suas DMs para receber o cargo!`);
    }
  }

  // reveal Caçador at start publicly
  const caçador = Array.from(jogo.players.values()).find(x => x.role === 'Caçador');
  const canal = await client.channels.fetch(jogo.channelId);
  if (caçador) {
    await canal.send(`🔍 O Caçador foi revelado: **${caçador.username}** (Cargo: Caçador).`);
  }

  lobby.clear(); // limpa lobby
  await sleep(1500);
  mainLoop(); // inicia o loop do jogo
}

/* ---------- Main Loop (Noite/Dia) ---------- */
async function mainLoop() {
  const canal = await client.channels.fetch(jogo.channelId);
  while (true) {
    if (!jogo) break;

    // checar fim de jogo antes de começar rodada
    if (verificarVitoria(canal)) break;

    jogo.nightCount++;
    jogo.round++;
    // NOITE
    await canal.send(`🌙 **Noite ${jogo.nightCount} caiu. Todos façam suas ações via DM.**`);
    await noiteFase();

    if (verificarVitoria(canal)) break;

    // DIA
    await canal.send(`🌞 **Dia ${jogo.round} amanheceu.**`);
    await votacaoFase();

    if (verificarVitoria(canal)) break;

    // loop continua
  }
}

/* ---------- Fase da noite: coleta e resolução de ações ---------- */
async function noiteFase() {
  const canal = await client.channels.fetch(jogo.channelId);
  // reset night actions container
  const nightActions = {
    mafiaTarget: null, // userId
    psicopataActions: [], // {byId, targetId, resultKill:boolean}
    anjoSave: null, // userId
    feiticeiraRevive: null, // userId
    feiticeiraPoison: null // userId
  };

  // 1) ASSASSINO (se vivo) escolhe vítima; se ele não agir, Aprendiz pode agir no lugar
  const assassino = findAliveRole('Assassino');
  const aprendiz = findAliveRole('Aprendiz de Assassino');

  if (assassino) {
    const chosen = await solicitarEscolhaDM(assassino.userId, 'Assassino — escolha uma vítima (não pode matar máfia)', availableTargetsForMafia());
    if (chosen) {
      nightActions.mafiaTarget = chosen;
      await dmReply(assassino.userId, '✅ Ataque registrado.');
    } else {
      // se não escolher, aprendiz pode escolher
      if (aprendiz) {
        const chosenA = await solicitarEscolhaDM(aprendiz.userId, 'Assassino não escolheu. Aprendiz: escolha uma vítima (pode usar 1x durante jogo caso o Assassino falhe).', availableTargetsForMafia());
        if (chosenA) {
          nightActions.mafiaTarget = chosenA;
          await dmReply(aprendiz.userId, '✅ Você agiu como aprendiz e escolheu a vítima.');
        }
      }
    }
  } else if (aprendiz) {
    // se assassino não existe (morreu), aprendiz age como substituto automaticamente
    const chosenA = await solicitarEscolhaDM(aprendiz.userId, 'Assassino está morto. Aprendiz: escolha uma vítima.', availableTargetsForMafia());
    if (chosenA) {
      nightActions.mafiaTarget = chosenA;
      await dmReply(aprendiz.userId, '✅ Ataque registrado.');
    }
  }

  // 2) PSICOPATA escolhe alvo e rola dado
  const psicopata = findAliveRole('Psicopata');
  if (psicopata) {
    const chosenP = await solicitarEscolhaDM(psicopata.userId, 'Psicopata — escolha alguém para girar o dado (ímpares = morte, pares = salvo).', availableTargetsAll());
    if (chosenP) {
      const dado = Math.floor(Math.random() * 6) + 1;
      const resultKill = (dado % 2 === 1);
      nightActions.psicopataActions.push({ byId: psicopata.userId, targetId: chosenP, dado, resultKill });
      await dmReply(psicopata.userId, `🎲 Dado lançado: ${dado}. Resultado: ${r
